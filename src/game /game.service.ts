import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { NotificationService } from '../notification/notification.service';
import { ForbiddenException } from '@nestjs/common';

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

  private async blockUser(userId: number, reason: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { isBlocked: true },
    });

    console.log('🚨 USER BLOCKED:', { userId, reason });
  }
  /** Достаём userId из JWT-токена */
  private getUserIdFromToken(token: string): number {
    if (!token) {
      throw new UnauthorizedException('Token is missing');
    }

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret) {
      throw new UnauthorizedException('JWT_SECRET is not configured');
    }

    try {
      const payload = jwt.verify(token, secret) as JwtPayload;
      if (!payload.userId) {
        throw new UnauthorizedException('Token payload has no userId');
      }
      return payload.userId;
    } catch (e) {
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
      orderBy: {
        _max: { score: 'desc' },
      },
      take: 20,
    });

    // Теперь нужно подтянуть данные юзеров
    const result = await Promise.all(
      bestScores.map(async (entry) => {
        const user = await this.prisma.user.findUnique({
          where: { id: entry.userId },
          select: { id: true, username: true, firstName: true },
        });

        return {
          id: entry.userId,
          score: entry._max.score,
          user,
        };
      }),
    );

    return result;
  }

  /** Начать игру: создаём Game в БД и возвращаем gameId + длительность раунда */
  async startGame(token: string) {
    const userId = this.getUserIdFromToken(token);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const baseDurationMs = 60_000; // 60 секунд
    const extraPerLevelMs = 5_000; // +5 секунд за уровень extra_time
    const extraTimeMs = (user.extraTimeLevel ?? 0) * extraPerLevelMs;
    const roundDurationMs = baseDurationMs + extraTimeMs;

    const game = await this.prisma.game.create({
      data: {
        userId,
      },
    });

    console.log(
      '[GameService.startGame] user.extraTimeLevel =',
      user.extraTimeLevel,
    );
    console.log('[GameService.startGame] roundDurationMs =', roundDurationMs);

    return {
      gameId: game.id,
      roundDurationMs,
    };
  }

  /** Завершить игру: сохранить score, clicks, epicCount, finishedAt + начислить звёзды, XP и реф.награду */
  async finishGame(
    token: string,
    gameId: number,
    score: number,
    clicks: number,
    epicCount: number,
  ) {
    const userId = this.getUserIdFromToken(token);

    // ─────────────────────────────────────
    // 0️⃣ USER + BLOCK CHECK (ВСЕГДА ПЕРВЫМ)
    // ─────────────────────────────────────
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
      },
    });

    if (!user) throw new UnauthorizedException('User not found');
    if (user.isBlocked) throw new ForbiddenException('User is blocked');

    // ─────────────────────────────────────
    // 1️⃣ BASIC PAYLOAD VALIDATION
    // ─────────────────────────────────────
    if (!gameId || Number.isNaN(gameId)) {
      throw new BadRequestException('Invalid gameId');
    }

    if (![score, clicks, epicCount].every(Number.isFinite)) {
      throw new BadRequestException('Invalid payload');
    }

    if (score < 0 || clicks < 0 || epicCount < 0) {
      throw new BadRequestException('Negative values are not allowed');
    }

    // ─────────────────────────────────────
    // 2️⃣ LOAD GAME + OWNERSHIP
    // ─────────────────────────────────────
    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game || game.userId !== userId) {
      throw new UnauthorizedException('Game not found or not yours');
    }

    if (game.finishedAt) {
      throw new BadRequestException('Game already finished');
    }

    // ─────────────────────────────────────
    // 3️⃣ TIME VALIDATION
    // ─────────────────────────────────────
    const BASE_DURATION_MS = 60_000;
    const EXTRA_TIME_PER_LEVEL_MS = 5_000;
    const ROUND_DURATION_MS =
      BASE_DURATION_MS + (user.extraTimeLevel ?? 0) * EXTRA_TIME_PER_LEVEL_MS;

    const durationMs = Date.now() - game.createdAt.getTime();

    const MIN_DURATION_MS = 8_000;
    if (durationMs < MIN_DURATION_MS) {
      await this.blockUser(userId, `finish too fast: ${durationMs}ms`);
      throw new ForbiddenException('Cheat detected');
    }

    const LATE_TOLERANCE_MS = 3_000;
    if (durationMs > ROUND_DURATION_MS + LATE_TOLERANCE_MS) {
      throw new BadRequestException('Round time exceeded');
    }

    // ─────────────────────────────────────
    // 4️⃣ GAME LIMITS (ТВОИ ЦИФРЫ)
    // ─────────────────────────────────────
    const MAX_TOTAL_CLICKS = 500;
    const MAX_EPIC_TOTAL = 50;

    if (clicks > MAX_TOTAL_CLICKS) {
      await this.blockUser(userId, `clicks overflow: ${clicks}`);
      throw new ForbiddenException('Cheat detected');
    }

    if (epicCount > MAX_EPIC_TOTAL) {
      await this.blockUser(userId, `epic overflow: ${epicCount}`);
      throw new ForbiddenException('Cheat detected');
    }

    if (epicCount > clicks) {
      await this.blockUser(userId, 'epicCount > clicks');
      throw new ForbiddenException('Cheat detected');
    }

    // ─────────────────────────────────────
    // 5️⃣ SCORE VALIDATION (SERVER TRUTH)
    // ─────────────────────────────────────
    const POINTS_PER_CLICK = 1;
    const POINTS_PER_EPIC = 50;

    const expectedScore =
      clicks * POINTS_PER_CLICK + epicCount * POINTS_PER_EPIC;

    if (score !== expectedScore) {
      await this.blockUser(
        userId,
        `score mismatch: ${score} vs ${expectedScore}`,
      );
      throw new ForbiddenException('Cheat detected');
    }

    // ─────────────────────────────────────
    // 6️⃣ ANTI-MACRO (PER SECOND)
    // ─────────────────────────────────────
    const seconds = Math.max(1, durationMs / 1000);

    const MAX_EPIC_RATIO = 0.25; // 25%

    if (epicCount / Math.max(1, clicks) > MAX_EPIC_RATIO) {
      await this.blockUser(
        userId,
        `epic/click ratio too high: ${epicCount}/${clicks}`,
      );
      throw new ForbiddenException('Cheat detected');
    }

    // ─────────────────────────────────────
    // 7️⃣ STARS + XP (SAFE ECONOMY)
    // ─────────────────────────────────────
    const starsEarnedRaw = Math.floor(score / 10);
    const starsEarned = Math.max(1, Math.min(starsEarnedRaw, 10));

    const xpGained = Math.floor(score / 2);

    let newLevel = user.level;
    let newXp = user.xp + xpGained;
    let leveledUp = false;

    while (newXp >= this.getXpForNextLevel(newLevel)) {
      newXp -= this.getXpForNextLevel(newLevel);
      newLevel++;
      leveledUp = true;
    }

    // ─────────────────────────────────────
    // 8️⃣ TRANSACTION: GAME + USER
    // ─────────────────────────────────────
    const [updatedGame, updatedUser] = await this.prisma.$transaction([
      this.prisma.game.update({
        where: { id: gameId },
        data: {
          score,
          clicks,
          epicCount,
          finishedAt: new Date(),
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          stars: { increment: starsEarned },
          level: newLevel,
          xp: newXp,
        },
        select: {
          stars: true,
          level: true,
          xp: true,
          telegramId: true,
        },
      }),
    ]);

    // ─────────────────────────────────────
    // 9️⃣ REFERRAL (FIRST GAME ONLY)
    // ─────────────────────────────────────
    let referralReward = 0;

    const gamesCount = await this.prisma.game.count({
      where: { userId, finishedAt: { not: null } },
    });

    if (gamesCount === 1) {
      const ref = await this.prisma.referral.findFirst({
        where: { invitedId: userId, rewarded: false },
        include: { inviter: true },
      });

      if (ref?.inviter) {
        referralReward = 50;

        await this.prisma.$transaction([
          this.prisma.user.update({
            where: { id: ref.inviterId },
            data: { stars: { increment: referralReward } },
          }),
          this.prisma.referral.update({
            where: { id: ref.id },
            data: { rewarded: true },
          }),
        ]);

        if (ref.inviter.telegramId) {
          await this.notificationService.sendReferralReward(
            ref.inviter.telegramId,
            referralReward,
          );
        }
      }
    }

    // ─────────────────────────────────────
    // ✅ RESULT
    // ─────────────────────────────────────
    return {
      ok: true,
      game: updatedGame,
      starsEarned,
      totalStars: updatedUser.stars,
      level: updatedUser.level,
      xp: updatedUser.xp,
      xpGained,
      leveledUp,
      referralReward,
    };
  }

  private getXpForNextLevel(level: number): number {
    // простая формула: чем выше уровень, тем больше нужно XP
    return 100 + (level - 1) * 500;
  }

  async getDailyQuests(token: string) {
    const userId = this.getUserIdFromToken(token);

    const now = new Date();
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);

    const [user, gamesToday] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.game.findMany({
        where: {
          userId,
          finishedAt: {
            gte: startOfDay,
          },
        },
      }),
    ]);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

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
    ].map((q) => ({
      ...q,
      claimable: q.completed && !q.claimedToday,
    }));

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
        where: {
          userId,
          finishedAt: {
            gte: startOfDay,
          },
        },
      }),
    ]);

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

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

    if (!completed) {
      throw new BadRequestException('Quest not completed yet');
    }

    if (alreadyClaimed) {
      throw new BadRequestException('Reward already claimed today');
    }

    userData.stars = { increment: reward };

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: userData,
    });

    return {
      questId,
      reward,
      stars: updatedUser.stars,
    };
  }
}
