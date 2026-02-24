import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { NotificationService } from '../notification/notification.service';
import { TicketType } from '@prisma/client';

interface JwtPayload {
  userId: number;
}

@Injectable()
export class GameService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notificationService: NotificationService,
  ) {}

  // ⚠️ Оставляем ТОЛЬКО для ручного админского бана (не для античита)
  private async blockUser(userId: number, reason: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { isBlocked: true },
    });
    console.log('🚨 USER BLOCKED (manual/admin):', { userId, reason });
  }

  /** Достаём userId из JWT-токена */
  private getUserIdFromToken(token: string): number {
    if (!token) throw new UnauthorizedException('Token is missing');

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret)
      throw new UnauthorizedException('JWT_SECRET is not configured');

    try {
      const payload = jwt.verify(token, secret) as JwtPayload;
      if (!payload.userId)
        throw new UnauthorizedException('Token payload has no userId');
      return payload.userId;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async getLeaderboard() {
    const bestScores = await this.prisma.game.groupBy({
      by: ['userId'],
      _max: { score: true },
      where: {
        score: { gt: 0 },
        finishedAt: { not: null },
      },
      orderBy: { _max: { score: 'desc' } },
      take: 20,
    });

    const users = await this.prisma.user.findMany({
      where: { id: { in: bestScores.map((b) => b.userId) } },
      select: { id: true, username: true, firstName: true },
    });

    const map = new Map(users.map((u) => [u.id, u]));

    return bestScores.map((entry) => ({
      id: entry.userId,
      score: entry._max.score ?? 0,
      user: map.get(entry.userId) ?? null,
    }));
  }

  /** Начать игру */
  async startGame(token: string) {
    const userId = this.getUserIdFromToken(token);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isBlocked: true, extraTimeLevel: true },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.isBlocked) throw new ForbiddenException('User is blocked');

    const baseDurationMs = 60_000; // 60 секунд
    const extraPerLevelMs = 5_000; // +5 секунд за уровень extra_time
    const extraTimeMs = (user.extraTimeLevel ?? 0) * extraPerLevelMs;
    const roundDurationMs = baseDurationMs + extraTimeMs;

    const game = await this.prisma.game.create({
      data: { userId },
    });

    return { gameId: game.id, roundDurationMs };
  }

  // ✅ единая функция: “игру не засчитываем”, закрываем, без наград
  private async invalidateGame(params: {
    gameId: number;
    userId: number;
    reason: string;
    // опционально: что пришло от клиента — чтобы видеть в логах
    payload?: {
      score?: number;
      clicks?: number;
      epicCount?: number;
      melasCount?: number;
    };
  }) {
    const { gameId, userId, reason, payload } = params;

    try {
      // Закрываем игру, чтобы нельзя было потом “дозавершить”
      await this.prisma.game.update({
        where: { id: gameId },
        data: {
          score: 0,
          clicks: 0,
          epicCount: 0,
          melasCount: 0 as any, // если поля нет — убери строку
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      // даже если update не прошёл — просто лог
      console.error('invalidateGame update failed', {
        gameId,
        userId,
        reason,
        e,
      });
    }

    console.warn('⚠️ GAME INVALIDATED:', { userId, gameId, reason, payload });
  }

  /**
   * Завершить игру
   * melasCount — сколько раз был пойман MELAS (даёт мясо)
   */
  async finishGame(
    token: string,
    gameId: number,
    score: number,
    clicks: number,
    epicCount: number,
    melasCount: number,
  ) {
    const userId = this.getUserIdFromToken(token);

    // 0) user + block check
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isBlocked: true,
        extraTimeLevel: true,
        level: true,
        xp: true,
        stars: true,
        telegramId: true,
        meat: true,
      },
    });

    if (!user) throw new UnauthorizedException('User not found');
    if (user.isBlocked) throw new ForbiddenException('User is blocked');

    // 1) basic validation
    if (!Number.isFinite(gameId) || gameId <= 0) {
      throw new BadRequestException('Invalid gameId');
    }

    const melasCountSafe = Number.isFinite(melasCount) ? melasCount : 0;
    const scoreSafe = Number.isFinite(score) ? score : 0;
    const clicksSafe = Number.isFinite(clicks) ? clicks : 0;
    const epicCountSafe = Number.isFinite(epicCount) ? epicCount : 0;

    if (
      [scoreSafe, clicksSafe, epicCountSafe, melasCountSafe].some((v) => v < 0)
    ) {
      throw new BadRequestException('Negative values are not allowed');
    }

    // 2) load game + ownership
    const game = await this.prisma.game.findUnique({ where: { id: gameId } });

    if (!game || game.userId !== userId) {
      throw new UnauthorizedException('Game not found or not yours');
    }
    if (game.finishedAt) {
      throw new BadRequestException('Game already finished');
    }

    // 3) time validation (НЕ БАНИМ, просто не засчитываем)
    const BASE_DURATION_MS = 60_000;
    const EXTRA_TIME_PER_LEVEL_MS = 5_000;
    const ROUND_DURATION_MS =
      BASE_DURATION_MS + (user.extraTimeLevel ?? 0) * EXTRA_TIME_PER_LEVEL_MS;

    const durationMs = Date.now() - game.createdAt.getTime();

    // ✅ снижено с 8000 → 5000 (меньше ложных срабатываний)
    if (durationMs < 5_000) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `finish too fast: ${durationMs}ms`,
        payload: {
          score: scoreSafe,
          clicks: clicksSafe,
          epicCount: epicCountSafe,
          melasCount: melasCountSafe,
        },
      });
      throw new BadRequestException('Game finished too fast (not counted)');
    }

    // ✅ даём больше “запаса” по времени: +10 сек (на лаги/телеграм/фон)
    if (durationMs > ROUND_DURATION_MS + 10_000) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `round time exceeded: ${durationMs}ms > ${ROUND_DURATION_MS + 10_000}ms`,
        payload: {
          score: scoreSafe,
          clicks: clicksSafe,
          epicCount: epicCountSafe,
          melasCount: melasCountSafe,
        },
      });
      throw new BadRequestException('Round time exceeded (not counted)');
    }

    // 4) anti-cheat (НЕ БАНИМ, просто не засчитываем)
    // Важное: любые странные метрики часто = баг клиента/дубль-запрос/глючный счетчик
    if (
      clicksSafe > 600 || // было 500 — чуть поднял
      epicCountSafe > 120 || // было 80 — слишком жёстко
      epicCountSafe > clicksSafe || // невозможно
      melasCountSafe > clicksSafe // невозможно
    ) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: 'invalid game metrics',
        payload: {
          score: scoreSafe,
          clicks: clicksSafe,
          epicCount: epicCountSafe,
          melasCount: melasCountSafe,
        },
      });
      throw new BadRequestException('Invalid game metrics (not counted)');
    }

    // ratio check (делаем мягче)
    const epicRatio = epicCountSafe / Math.max(1, clicksSafe);
    if (epicRatio > 0.55) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `epic ratio too high: ${epicRatio.toFixed(3)}`,
        payload: {
          score: scoreSafe,
          clicks: clicksSafe,
          epicCount: epicCountSafe,
          melasCount: melasCountSafe,
        },
      });
      throw new BadRequestException('Suspicious metrics (not counted)');
    }

    // 5) server score (игнорируем client score)
    const serverScore = clicksSafe + epicCountSafe * 10;

    // 6) stars
    let starsEarned = Math.floor(serverScore / 12);
    starsEarned = Math.max(starsEarned, 3);
    starsEarned = Math.min(starsEarned, 25);

    if (serverScore >= 250) starsEarned += 5;
    if (serverScore >= 350) starsEarned += 5;

    starsEarned = Math.min(starsEarned, 35);

    // 6.5) meat — только за melas
    const meatEarned = melasCountSafe;

    // 7) XP + level
    const xpGained = Math.floor(serverScore / 2);

    let newLevel = user.level;
    let newXp = user.xp + xpGained;
    let leveledUp = false;

    while (newXp >= this.getXpForNextLevel(newLevel)) {
      newXp -= this.getXpForNextLevel(newLevel);
      newLevel += 1;
      leveledUp = true;
    }

    // 8) transaction: update game + user
    const [updatedGame, updatedUser] = await this.prisma.$transaction([
      this.prisma.game.update({
        where: { id: gameId },
        data: {
          // ✅ пишем serverScore, а не клиентский score
          score: serverScore,
          clicks: clicksSafe,
          epicCount: epicCountSafe,
          melasCount: melasCountSafe as any, // если поля нет — убери строку
          finishedAt: new Date(),
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          stars: { increment: starsEarned },
          level: newLevel,
          xp: newXp,
          meat: { increment: meatEarned },
        },
        select: {
          stars: true,
          level: true,
          xp: true,
          meat: true,
          telegramId: true,
        },
      }),
    ]);

    // 9) referral — реально только за первый “засчитанный finished game”
    let referralRewardTickets = 0;

    const finishedCount = await this.prisma.game.count({
      where: { userId, finishedAt: { not: null }, score: { gt: 0 } }, // score>0 = засчитанные игры
    });

    if (finishedCount === 1) {
      const referral = await this.prisma.referral.findFirst({
        where: { invitedId: userId, rewarded: false },
        include: { inviter: true },
      });

      if (referral?.inviter) {
        const REFERRAL_TICKETS = 5;
        referralRewardTickets = REFERRAL_TICKETS;

        await this.prisma.$transaction([
          ...Array.from({ length: REFERRAL_TICKETS }).map(() =>
            this.prisma.ticket.create({
              data: { userId: referral.inviterId, type: TicketType.REFERRAL },
            }),
          ),
          this.prisma.referral.update({
            where: { id: referral.id },
            data: { rewarded: true },
          }),
        ]);

        try {
          if (referral.inviter.telegramId) {
            await this.notificationService.sendReferralReward(
              referral.inviter.telegramId,
              REFERRAL_TICKETS,
            );
          }
        } catch (e) {
          console.error('Referral notification failed', e);
        }
      }
    }

    return {
      ok: true,
      game: updatedGame,

      // клиенту показываем то, что реально засчитано
      serverScore,

      starsEarned,
      totalStars: updatedUser.stars,

      level: updatedUser.level,
      xp: updatedUser.xp,
      xpGained,
      leveledUp,

      melasCount: melasCountSafe,

      meatEarned,
      totalMeat: updatedUser.meat,

      referralRewardTickets,
    };
  }

  private getXpForNextLevel(level: number): number {
    return 100 + (level - 1) * 500;
  }

  // ─────────────────────────────────────────
  // DAILY QUESTS (как у тебя было) — без изменений
  // ─────────────────────────────────────────
  async getDailyQuests(token: string) {
    const userId = this.getUserIdFromToken(token);

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const [user, gamesToday] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.game.findMany({
        where: { userId, finishedAt: { gte: startOfDay } },
      }),
    ]);

    if (!user) throw new UnauthorizedException('User not found');

    const totalClicks = gamesToday.reduce((sum, g) => sum + (g.clicks ?? 0), 0);
    const totalEpics = gamesToday.reduce(
      (sum, g) => sum + (g.epicCount ?? 0),
      0,
    );
    const gamesCount = gamesToday.length;

    const quests = [
      {
        id: 'catch_1000',
        title: 'Поймай 1000 монстров',
        target: 1000,
        current: totalClicks,
        reward: 100,
        rewardLabel: '+100 ⭐',
        completed: totalClicks >= 1000,
        claimedToday:
          !!user.dailyCatch1000ClaimAt &&
          user.dailyCatch1000ClaimAt >= startOfDay,
      },
      {
        id: 'epic_100',
        title: 'Поймай 100 эпических монстров',
        target: 100,
        current: totalEpics,
        reward: 50,
        rewardLabel: '+50 ⭐',
        completed: totalEpics >= 100,
        claimedToday:
          !!user.dailyEpic100ClaimAt && user.dailyEpic100ClaimAt >= startOfDay,
      },
      {
        id: 'play_3',
        title: 'Сыграй 3 игры за сегодня',
        target: 3,
        current: gamesCount,
        reward: 20,
        rewardLabel: '+20 ⭐',
        completed: gamesCount >= 3,
        claimedToday:
          !!user.dailyPlay3ClaimAt && user.dailyPlay3ClaimAt >= startOfDay,
      },
    ].map((q) => ({ ...q, claimable: q.completed && !q.claimedToday }));

    return {
      date: startOfDay.toISOString().slice(0, 10),
      quests: quests.map((q) => ({
        id: q.id,
        title: q.title,
        target: q.target,
        current: q.current,
        reward: q.reward,
        rewardLabel: q.rewardLabel,
        completed: q.completed,
        claimed: q.claimedToday,
        claimable: q.claimable,
      })),
      stars: user.stars,
    };
  }

  async claimDailyQuest(token: string, questId: string) {
    const userId = this.getUserIdFromToken(token);

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const [user, gamesToday] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.game.findMany({
        where: { userId, finishedAt: { gte: startOfDay } },
      }),
    ]);

    if (!user) throw new UnauthorizedException('User not found');

    const totalClicks = gamesToday.reduce((sum, g) => sum + (g.clicks ?? 0), 0);
    const totalEpics = gamesToday.reduce(
      (sum, g) => sum + (g.epicCount ?? 0),
      0,
    );
    const gamesCount = gamesToday.length;

    let completed = false;
    let alreadyClaimed = false;
    let reward = 0;
    const userData: any = {};

    if (questId === 'catch_1000') {
      completed = totalClicks >= 1000;
      alreadyClaimed =
        !!user.dailyCatch1000ClaimAt &&
        user.dailyCatch1000ClaimAt >= startOfDay;
      reward = 100;
      userData.dailyCatch1000ClaimAt = now;
    } else if (questId === 'epic_100') {
      completed = totalEpics >= 100;
      alreadyClaimed =
        !!user.dailyEpic100ClaimAt && user.dailyEpic100ClaimAt >= startOfDay;
      reward = 50;
      userData.dailyEpic100ClaimAt = now;
    } else if (questId === 'play_3') {
      completed = gamesCount >= 3;
      alreadyClaimed =
        !!user.dailyPlay3ClaimAt && user.dailyPlay3ClaimAt >= startOfDay;
      reward = 20;
      userData.dailyPlay3ClaimAt = now;
    } else {
      throw new BadRequestException('Unknown quest');
    }

    if (!completed) throw new BadRequestException('Quest not completed yet');
    if (alreadyClaimed)
      throw new BadRequestException('Reward already claimed today');

    userData.stars = { increment: reward };

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: userData,
      select: { stars: true },
    });

    return { questId, reward, stars: updatedUser.stars };
  }
}
