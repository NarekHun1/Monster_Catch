import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { NotificationService } from '../notification/notification.service';

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

    console.log('[GameService.finishGame] input =', {
      userId,
      gameId,
      score,
      clicks,
      epicCount,
    });

    if (!gameId || Number.isNaN(gameId)) {
      throw new BadRequestException('Invalid gameId');
    }

    if (score === null || score === undefined || Number.isNaN(score)) {
      throw new BadRequestException('Invalid score');
    }

    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game || game.userId !== userId) {
      throw new UnauthorizedException('Game not found or not yours');
    }

    // ⭐ звёзды за игру
    const starsEarned = Math.max(1, Math.floor((score ?? 0) / 5));

    // Сохраняем результат игры
    const updatedGame = await this.prisma.game.update({
      where: { id: gameId },
      data: {
        score,
        clicks,
        epicCount,
        finishedAt: new Date(),
      },
    });

    // Получаем текущего пользователя (для XP/level/telegramId)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        level: true,
        xp: true,
        stars: true,
        telegramId: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    // 📈 опыт за игру
    const xpGained = score ?? 0;
    let newLevel = user.level;
    let newXp = user.xp + xpGained;
    let leveledUp = false;

    while (newXp >= this.getXpForNextLevel(newLevel)) {
      newXp -= this.getXpForNextLevel(newLevel);
      newLevel++;
      leveledUp = true;
    }

    // Обновляем пользователя: звёзды + уровень + XP
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: {
        stars: { increment: starsEarned },
        level: newLevel,
        xp: newXp,
      },
      select: { stars: true, level: true, xp: true, telegramId: true },
    });

    console.log('[GameService.finishGame] Game saved');
    console.log('[GameService.finishGame] User stars =', updatedUser.stars);

    // 🎁 РЕФЕРАЛЬНАЯ НАГРАДА
    let referralReward = 0;

    // Считаем, сколько завершённых игр у пользователя
    const gamesCount = await this.prisma.game.count({
      where: { userId, finishedAt: { not: null } },
    });

    const isFirstGame = gamesCount === 1;

    if (isFirstGame) {
      console.log(`🎉 FIRST GAME of user ${userId}`);

      const ref = await this.prisma.referral.findFirst({
        where: {
          invitedId: userId,
          rewarded: false,
        },
        include: {
          inviter: true,
        },
      });

      if (ref && ref.inviter) {
        console.log(`🎁 Giving referral reward to inviter ${ref.inviterId}`);

        referralReward = 50;

        await this.prisma.user.update({
          where: { id: ref.inviterId },
          data: {
            stars: { increment: referralReward },
          },
        });

        await this.prisma.referral.update({
          where: { id: ref.id },
          data: { rewarded: true },
        });

        if (ref.inviter.telegramId) {
          await this.notificationService.sendReferralReward(
            ref.inviter.telegramId,
            referralReward,
          );
        }
      }
    }

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
    return 100 + (level - 1) * 50;
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
      reward = 500;
      userData.dailyCatch1000ClaimAt = now;
    } else if (questId === 'epic_100') {
      completed = totalEpics >= 100;
      alreadyClaimed =
        !!user.dailyEpic100ClaimAt && user.dailyEpic100ClaimAt >= startOfDay;
      reward = 300;
      userData.dailyEpic100ClaimAt = now;
    } else if (questId === 'play_3') {
      completed = gamesCount >= 3;
      alreadyClaimed =
        !!user.dailyPlay3ClaimAt && user.dailyPlay3ClaimAt >= startOfDay;
      reward = 80;
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
