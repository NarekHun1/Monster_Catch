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

type RawTap = {
  at?: number;
  x?: number;
  y?: number;
  hit?: boolean;
  targetType?: string | null;
  spawnedAt?: number | null;
};

type NormalizedTap = {
  at: number;
  x: number;
  y: number;
  hit: boolean;
  targetType: string | null;
  spawnedAt: number | null;
};

type TapMetrics = {
  totalClicks: number;
  hits: number;
  emptyClicks: number;
  epicHits: number;
  melasHits: number;
  rareHits: number;
  legendaryHits: number;
  commonHits: number;
  hitRate: number;

  avgIntervalMs: number;
  intervalStdMs: number;

  avgReactionMs: number | null;
  reactionStdMs: number | null;
  fastestReactionMs: number | null;

  longestHitStreak: number;
};

type SuspicionResult = {
  suspicionScore: number;
  reasons: string[];
};

@Injectable()
export class GameService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notificationService: NotificationService,
  ) {}

  // Только для ручного админского бана
  private async blockUser(userId: number, reason: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { isBlocked: true },
    });

    console.log('🚨 USER BLOCKED (manual/admin):', { userId, reason });
  }

  private getUserIdFromToken(token: string): number {
    if (!token) throw new UnauthorizedException('Token is missing');

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
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async getLeaderboard() {
    const [gameBestScores, tournamentBestScores, users] = await Promise.all([
      this.prisma.game.groupBy({
        by: ['userId'],
        _max: { score: true },
        where: {
          score: { gt: 0 },
          finishedAt: { not: null },
          invalidated: false,
        },
      }),

      this.prisma.tournamentParticipant.groupBy({
        by: ['userId'],
        _max: { score: true },
        where: {
          score: { gt: 0 },
        },
      }),

      this.prisma.user.findMany({
        where: {
          isBlocked: false,
          isBot: false,
        },
        select: {
          id: true,
          username: true,
          firstName: true,
        },
      }),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u]));
    const scoreMap = new Map<number, number>();

    for (const row of gameBestScores) {
      const best = row._max.score ?? 0;
      if (best > 0) scoreMap.set(row.userId, best);
    }

    for (const row of tournamentBestScores) {
      const tournamentBest = row._max.score ?? 0;
      const currentBest = scoreMap.get(row.userId) ?? 0;

      if (tournamentBest > currentBest) {
        scoreMap.set(row.userId, tournamentBest);
      }
    }

    return Array.from(scoreMap.entries())
      .filter(([userId, score]) => score > 0 && userMap.has(userId))
      .map(([userId, score]) => ({
        id: userId,
        score,
        user: userMap.get(userId) ?? null,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
  }

  async startGame(token: string) {
    const userId = this.getUserIdFromToken(token);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, isBlocked: true, extraTimeLevel: true },
    });

    if (!user) throw new UnauthorizedException('User not found');
    if (user.isBlocked) throw new ForbiddenException('User is blocked');

    const baseDurationMs = 60_000;
    const extraPerLevelMs = 5_000;
    const extraTimeMs = (user.extraTimeLevel ?? 0) * extraPerLevelMs;
    const roundDurationMs = baseDurationMs + extraTimeMs;

    const game = await this.prisma.game.create({
      data: {
        userId,
        emptyClicks: 0,
        hitRate: 0,
        avgIntervalMs: 0,
        intervalStdMs: 0,
        avgReactionMs: null,
        reactionStdMs: null,
        fastestReactionMs: null,
        longestHitStreak: 0,
        invalidated: false,
        invalidReason: null,
        suspicionScore: 0,
        suspicionReasons: [],
      },
    });

    return { gameId: game.id, roundDurationMs };
  }

  private avg(nums: number[]): number {
    if (!nums.length) return 0;
    return nums.reduce((sum, n) => sum + n, 0) / nums.length;
  }

  private std(nums: number[]): number {
    if (!nums.length) return 0;
    const mean = this.avg(nums);
    const variance =
      nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / nums.length;
    return Math.sqrt(variance);
  }

  private normalizeTaps(
    rawTaps: RawTap[],
    roundDurationMs: number,
  ): NormalizedTap[] {
    if (!Array.isArray(rawTaps)) return [];

    const taps = rawTaps
      .filter((t) => t && typeof t === 'object')
      .map((tap) => ({
        at:
          Number.isFinite(tap.at) && (tap.at as number) >= 0
            ? Math.floor(tap.at as number)
            : 0,
        x: Number.isFinite(tap.x) ? Number(tap.x) : 0,
        y: Number.isFinite(tap.y) ? Number(tap.y) : 0,
        hit: Boolean(tap.hit),
        targetType: tap.targetType ?? null,
        spawnedAt:
          tap.spawnedAt == null || !Number.isFinite(tap.spawnedAt)
            ? null
            : Math.floor(tap.spawnedAt),
      }))
      .filter((tap) => tap.at >= 0 && tap.at <= roundDurationMs + 10_000)
      .sort((a, b) => a.at - b.at);

    return taps;
  }

  private analyzeTaps(taps: NormalizedTap[]): TapMetrics {
    const totalClicks = taps.length;
    let hits = 0;
    let emptyClicks = 0;
    let epicHits = 0;
    let melasHits = 0;
    let rareHits = 0;
    let legendaryHits = 0;
    let commonHits = 0;

    const intervals: number[] = [];
    const reactions: number[] = [];

    for (let i = 0; i < taps.length; i++) {
      const tap = taps[i];
      const prev = taps[i - 1];

      if (prev) {
        intervals.push(tap.at - prev.at);
      }

      if (tap.hit) {
        hits++;

        if (tap.targetType === 'EPIC') {
          epicHits++;
        } else if (tap.targetType === 'MELAS') {
          melasHits++;
        } else if (tap.targetType === 'RARE') {
          rareHits++;
        } else if (tap.targetType === 'LEGENDARY') {
          legendaryHits++;
        } else {
          commonHits++;
        }

        if (
          tap.spawnedAt !== null &&
          Number.isFinite(tap.spawnedAt) &&
          tap.spawnedAt >= 0 &&
          tap.spawnedAt <= tap.at
        ) {
          reactions.push(tap.at - tap.spawnedAt);
        }
      } else {
        emptyClicks++;
      }
    }

    let longestHitStreak = 0;
    let currentStreak = 0;

    for (const tap of taps) {
      if (tap.hit) {
        currentStreak++;
        if (currentStreak > longestHitStreak) {
          longestHitStreak = currentStreak;
        }
      } else {
        currentStreak = 0;
      }
    }

    return {
      totalClicks,
      hits,
      emptyClicks,
      epicHits,
      melasHits,
      rareHits,
      legendaryHits,
      commonHits,
      hitRate: totalClicks > 0 ? hits / totalClicks : 0,

      avgIntervalMs: this.avg(intervals),
      intervalStdMs: this.std(intervals),

      avgReactionMs: reactions.length ? this.avg(reactions) : null,
      reactionStdMs: reactions.length ? this.std(reactions) : null,
      fastestReactionMs: reactions.length ? Math.min(...reactions) : null,

      longestHitStreak,
    };
  }

  private calculateServerScore(metrics: TapMetrics): number {
    return (
      metrics.commonHits * 1 +
      metrics.rareHits * 3 +
      metrics.legendaryHits * 5 +
      metrics.melasHits * 1 +
      metrics.epicHits * 10
    );
  }

  private buildSuspicionScore(params: {
    durationMs: number;
    roundDurationMs: number;
    metrics: TapMetrics;
    serverScore: number;
  }): SuspicionResult {
    const { durationMs, roundDurationMs, metrics, serverScore } = params;

    let suspicionScore = 0;
    const reasons: string[] = [];

    const clicksPerSecond =
      durationMs > 0 ? metrics.totalClicks / (durationMs / 1000) : 0;

    const epicRatio = metrics.epicHits / Math.max(1, metrics.totalClicks);
    const normalizedDuration =
      roundDurationMs > 0 ? durationMs / roundDurationMs : 1;

    const roboticIntervals =
      metrics.avgIntervalMs > 0 &&
      metrics.avgIntervalMs < 95 &&
      metrics.intervalStdMs > 0 &&
      metrics.intervalStdMs < 14;

    const roboticReactions =
      metrics.avgReactionMs !== null &&
      metrics.avgReactionMs < 95 &&
      metrics.reactionStdMs !== null &&
      metrics.reactionStdMs > 0 &&
      metrics.reactionStdMs < 16;

    if (metrics.totalClicks >= 140 && metrics.emptyClicks === 0) {
      suspicionScore += 2;
      reasons.push('no misses in very long round');
    }

    if (metrics.totalClicks >= 180 && metrics.hitRate > 0.985) {
      suspicionScore += 2;
      reasons.push(
        `hitRate unrealistically high: ${metrics.hitRate.toFixed(3)}`,
      );
    }

    if (metrics.fastestReactionMs !== null && metrics.fastestReactionMs < 55) {
      suspicionScore += 2;
      reasons.push(`very fast reaction: ${metrics.fastestReactionMs}ms`);
    }

    if (metrics.fastestReactionMs !== null && metrics.fastestReactionMs < 45) {
      suspicionScore += 3;
      reasons.push(`near-impossible reaction: ${metrics.fastestReactionMs}ms`);
    }

    if (
      metrics.avgReactionMs !== null &&
      metrics.totalClicks >= 120 &&
      metrics.avgReactionMs < 95
    ) {
      suspicionScore += 2;
      reasons.push(
        `avg reaction too fast: ${metrics.avgReactionMs.toFixed(1)}ms`,
      );
    }

    if (roboticIntervals) {
      suspicionScore += 4;
      reasons.push(
        `robotic intervals avg=${metrics.avgIntervalMs.toFixed(1)}ms std=${metrics.intervalStdMs.toFixed(1)}ms`,
      );
    }

    if (roboticReactions) {
      suspicionScore += 4;
      reasons.push(
        `robotic reactions avg=${metrics.avgReactionMs!.toFixed(1)}ms std=${metrics.reactionStdMs!.toFixed(1)}ms`,
      );
    }

    if (metrics.longestHitStreak >= 110) {
      suspicionScore += 2;
      reasons.push(`very long perfect streak: ${metrics.longestHitStreak}`);
    }

    if (metrics.longestHitStreak >= 150) {
      suspicionScore += 3;
      reasons.push(`extreme perfect streak: ${metrics.longestHitStreak}`);
    }

    if (clicksPerSecond > 8.5) {
      suspicionScore += 2;
      reasons.push(`very fast clicksPerSecond: ${clicksPerSecond.toFixed(2)}`);
    }

    if (clicksPerSecond > 9.5) {
      suspicionScore += 3;
      reasons.push(`extreme clicksPerSecond: ${clicksPerSecond.toFixed(2)}`);
    }

    if (metrics.totalClicks >= 100 && epicRatio > 0.34) {
      suspicionScore += 2;
      reasons.push(`high epic ratio: ${epicRatio.toFixed(3)}`);
    }

    if (metrics.totalClicks >= 100 && epicRatio > 0.42) {
      suspicionScore += 3;
      reasons.push(`extreme epic ratio: ${epicRatio.toFixed(3)}`);
    }

    if (serverScore >= 650 && (roboticIntervals || roboticReactions)) {
      suspicionScore += 2;
      reasons.push(`high score combined with robotic metrics: ${serverScore}`);
    }

    if (
      normalizedDuration < 0.35 &&
      serverScore >= 350 &&
      (roboticIntervals || roboticReactions || clicksPerSecond > 9)
    ) {
      suspicionScore += 3;
      reasons.push('high score in too short duration with suspicious speed');
    }

    return { suspicionScore, reasons };
  }

  private getStarsEarned(serverScore: number): number {
    let starsEarned = Math.floor(serverScore / 12);
    starsEarned = Math.max(starsEarned, 3);
    starsEarned = Math.min(starsEarned, 25);

    if (serverScore >= 250) starsEarned += 5;
    if (serverScore >= 350) starsEarned += 5;

    return Math.min(starsEarned, 35);
  }

  private getXpForNextLevel(level: number): number {
    return 100 + (level - 1) * 500;
  }

  private async invalidateGame(params: {
    gameId: number;
    userId: number;
    reason: string;
    suspicionScore?: number;
    suspicionReasons?: string[];
  }) {
    const { gameId, userId, reason, suspicionScore, suspicionReasons } = params;

    try {
      await this.prisma.game.update({
        where: { id: gameId },
        data: {
          score: 0,
          clicks: 0,
          epicCount: 0,
          melasCount: 0,
          emptyClicks: 0,
          hitRate: 0,
          avgIntervalMs: 0,
          intervalStdMs: 0,
          avgReactionMs: null,
          reactionStdMs: null,
          fastestReactionMs: null,
          longestHitStreak: 0,
          invalidated: true,
          invalidReason: reason,
          suspicionScore: suspicionScore ?? 0,
          suspicionReasons: suspicionReasons ?? [],
          finishedAt: new Date(),
        },
      });
    } catch (e) {
      console.error('invalidateGame update failed', {
        gameId,
        userId,
        reason,
        e,
      });
    }

    console.warn('⚠️ GAME INVALIDATED', {
      userId,
      gameId,
      reason,
      suspicionScore,
      suspicionReasons,
    });
  }

  /**
   * LEGACY finish — не ломает старый фронт
   * Если rawTaps пришли -> автоматом используем V2 anti-cheat
   */
  async finishGame(
    token: string,
    gameId: number,
    score: number,
    clicks: number,
    epicCount: number,
    melasCount: number,
    rawTaps: RawTap[] = [],
  ) {
    if (Array.isArray(rawTaps) && rawTaps.length > 0) {
      return this.finishGameV2(
        token,
        gameId,
        score,
        clicks,
        epicCount,
        melasCount,
        rawTaps,
      );
    }

    const userId = this.getUserIdFromToken(token);

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

    if (!Number.isFinite(gameId) || gameId <= 0) {
      throw new BadRequestException('Invalid gameId');
    }

    const scoreSafe = Number.isFinite(score) ? Math.floor(score) : 0;
    const clicksSafe = Number.isFinite(clicks) ? Math.floor(clicks) : 0;
    const epicCountSafe = Number.isFinite(epicCount)
      ? Math.floor(epicCount)
      : 0;
    const melasCountSafe = Number.isFinite(melasCount)
      ? Math.floor(melasCount)
      : 0;

    if (
      [scoreSafe, clicksSafe, epicCountSafe, melasCountSafe].some((v) => v < 0)
    ) {
      throw new BadRequestException('Negative values are not allowed');
    }

    const game = await this.prisma.game.findUnique({ where: { id: gameId } });

    if (!game || game.userId !== userId) {
      throw new UnauthorizedException('Game not found or not yours');
    }

    if (game.finishedAt) {
      throw new BadRequestException('Game already finished');
    }

    const BASE_DURATION_MS = 60_000;
    const EXTRA_TIME_PER_LEVEL_MS = 5_000;
    const ROUND_DURATION_MS =
      BASE_DURATION_MS + (user.extraTimeLevel ?? 0) * EXTRA_TIME_PER_LEVEL_MS;

    const durationMs = Date.now() - game.createdAt.getTime();

    if (durationMs < 5_000) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `finish too fast: ${durationMs}ms`,
      });
      throw new BadRequestException('Game finished too fast (not counted)');
    }

    if (durationMs > ROUND_DURATION_MS + 10_000) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `round time exceeded: ${durationMs}ms`,
      });
      throw new BadRequestException('Round time exceeded (not counted)');
    }

    if (clicksSafe > 600) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `too many clicks: ${clicksSafe}`,
      });
      throw new BadRequestException('Suspicious clicks detected');
    }

    if (epicCountSafe > clicksSafe) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `epicCount > clicks (${epicCountSafe} > ${clicksSafe})`,
      });
      throw new BadRequestException('Suspicious epic count');
    }

    if (melasCountSafe > clicksSafe) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `melasCount > clicks (${melasCountSafe} > ${clicksSafe})`,
      });
      throw new BadRequestException('Suspicious melas count');
    }

    const epicRatio = clicksSafe > 0 ? epicCountSafe / clicksSafe : 0;
    if (clicksSafe >= 80 && epicRatio > 0.55) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `epic ratio too high: ${epicRatio.toFixed(3)}`,
      });
      throw new BadRequestException('Suspicious epic ratio');
    }

    if (scoreSafe > 590) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `score above hard cap: ${scoreSafe}`,
      });
      throw new BadRequestException('Suspicious score detected');
    }

    let starsEarned = Math.floor(scoreSafe / 12);
    starsEarned = Math.max(starsEarned, 3);
    starsEarned = Math.min(starsEarned, 25);

    if (scoreSafe >= 250) starsEarned += 5;
    if (scoreSafe >= 350) starsEarned += 5;

    starsEarned = Math.min(starsEarned, 35);

    const meatEarned = melasCountSafe;
    const xpGained = Math.floor(scoreSafe / 2);

    let newLevel = user.level;
    let newXp = user.xp + xpGained;
    let leveledUp = false;

    while (newXp >= this.getXpForNextLevel(newLevel)) {
      newXp -= this.getXpForNextLevel(newLevel);
      newLevel += 1;
      leveledUp = true;
    }

    const [updatedGame, updatedUser] = await this.prisma.$transaction([
      this.prisma.game.update({
        where: { id: gameId },
        data: {
          score: scoreSafe,
          clicks: clicksSafe,
          epicCount: epicCountSafe,
          melasCount: melasCountSafe,
          emptyClicks: 0,
          hitRate: clicksSafe > 0 ? 1 : 0,
          avgIntervalMs: 0,
          intervalStdMs: 0,
          avgReactionMs: null,
          reactionStdMs: null,
          fastestReactionMs: null,
          longestHitStreak: 0,
          invalidated: false,
          invalidReason: null,
          suspicionScore: 0,
          suspicionReasons: [],
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

    let referralRewardTickets = 0;

    const finishedCount = await this.prisma.game.count({
      where: {
        userId,
        finishedAt: { not: null },
        score: { gt: 0 },
        invalidated: false,
      },
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
      mode: 'legacy',
      game: updatedGame,
      serverScore: scoreSafe,

      starsEarned,
      totalStars: updatedUser.stars,

      level: updatedUser.level,
      xp: updatedUser.xp,
      xpGained,
      leveledUp,

      meatEarned,
      totalMeat: updatedUser.meat,

      melasCount: melasCountSafe,
      referralRewardTickets,
    };
  }

  /**
   * Сильный anti-cheat по tap-логам
   */
  async finishGameV2(
    token: string,
    gameId: number,
    clientScore: number,
    clientClicks: number,
    clientEpicCount: number,
    clientMelasCount: number,
    rawTaps: RawTap[],
  ) {
    const userId = this.getUserIdFromToken(token);

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

    if (!Number.isFinite(gameId) || gameId <= 0) {
      throw new BadRequestException('Invalid gameId');
    }

    const game = await this.prisma.game.findUnique({
      where: { id: gameId },
    });

    if (!game || game.userId !== userId) {
      throw new UnauthorizedException('Game not found or not yours');
    }

    if (game.finishedAt) {
      throw new BadRequestException('Game already finished');
    }

    const BASE_DURATION_MS = 60_000;
    const EXTRA_TIME_PER_LEVEL_MS = 5_000;
    const ROUND_DURATION_MS =
      BASE_DURATION_MS + (user.extraTimeLevel ?? 0) * EXTRA_TIME_PER_LEVEL_MS;

    const durationMs = Date.now() - game.createdAt.getTime();

    if (durationMs < 5_000) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `finish too fast: ${durationMs}ms`,
      });
      throw new BadRequestException('Game finished too fast (not counted)');
    }

    if (durationMs > ROUND_DURATION_MS + 10_000) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `round time exceeded: ${durationMs}ms`,
      });
      throw new BadRequestException('Round time exceeded (not counted)');
    }

    const taps = this.normalizeTaps(rawTaps, ROUND_DURATION_MS);
    const metrics = this.analyzeTaps(taps);

    if (metrics.totalClicks === 0) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: 'no taps provided',
      });
      throw new BadRequestException('No taps provided');
    }

    if (metrics.totalClicks > 520) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `too many taps: ${metrics.totalClicks}`,
      });
      throw new BadRequestException('Too many taps');
    }

    if (metrics.fastestReactionMs !== null && metrics.fastestReactionMs < 40) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `impossible fastest reaction: ${metrics.fastestReactionMs}ms`,
      });
      throw new BadRequestException('Impossible reaction speed');
    }

    if (metrics.avgIntervalMs > 0 && metrics.avgIntervalMs < 58) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: `impossible avg interval: ${metrics.avgIntervalMs.toFixed(1)}ms`,
      });
      throw new BadRequestException('Impossible click speed');
    }

    const serverScore = this.calculateServerScore(metrics);

    const scoreDelta = Math.abs((clientScore || 0) - serverScore);
    const clicksDelta = Math.abs((clientClicks || 0) - metrics.totalClicks);
    const epicDelta = Math.abs((clientEpicCount || 0) - metrics.epicHits);
    const melasDelta = Math.abs((clientMelasCount || 0) - metrics.melasHits);

    if (scoreDelta > 40 || clicksDelta > 8 || epicDelta > 5 || melasDelta > 5) {
      await this.invalidateGame({
        gameId,
        userId,
        reason:
          `client/server mismatch ` +
          `(scoreΔ=${scoreDelta}, clicksΔ=${clicksDelta}, epicΔ=${epicDelta}, melasΔ=${melasDelta})`,
      });
      throw new BadRequestException('Client metrics mismatch');
    }

    const { suspicionScore, reasons } = this.buildSuspicionScore({
      durationMs,
      roundDurationMs: ROUND_DURATION_MS,
      metrics,
      serverScore,
    });

    const hasRobotPattern =
      (metrics.intervalStdMs > 0 && metrics.intervalStdMs < 14) ||
      (metrics.reactionStdMs !== null &&
        metrics.reactionStdMs > 0 &&
        metrics.reactionStdMs < 16);

    const hasImpossiblePattern =
      (metrics.fastestReactionMs !== null && metrics.fastestReactionMs < 40) ||
      (metrics.avgIntervalMs > 0 && metrics.avgIntervalMs < 58);

    if (suspicionScore >= 11 || (suspicionScore >= 9 && hasImpossiblePattern)) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: 'anti-cheat hard reject',
        suspicionScore,
        suspicionReasons: reasons,
      });
      throw new BadRequestException('Suspicious game detected');
    }

    if (serverScore >= 650 && suspicionScore >= 8 && hasRobotPattern) {
      await this.invalidateGame({
        gameId,
        userId,
        reason: 'anti-cheat reject: high score with robotic metrics',
        suspicionScore,
        suspicionReasons: reasons,
      });
      throw new BadRequestException('Suspicious high-score game');
    }

    const starsEarned = this.getStarsEarned(serverScore);
    const meatEarned = metrics.melasHits;
    const xpGained = Math.floor(serverScore / 2);

    let newLevel = user.level;
    let newXp = user.xp + xpGained;
    let leveledUp = false;

    while (newXp >= this.getXpForNextLevel(newLevel)) {
      newXp -= this.getXpForNextLevel(newLevel);
      newLevel += 1;
      leveledUp = true;
    }

    const [, updatedGame, updatedUser] = await this.prisma.$transaction([
      this.prisma.gameTap.createMany({
        data: taps.map((t) => ({
          gameId,
          atMs: t.at,
          x: t.x,
          y: t.y,
          hit: t.hit,
          targetType: t.targetType ?? null,
          spawnedAtMs: t.spawnedAt,
        })),
      }),
      this.prisma.game.update({
        where: { id: gameId },
        data: {
          score: serverScore,
          clicks: metrics.totalClicks,
          epicCount: metrics.epicHits,
          melasCount: metrics.melasHits,
          emptyClicks: metrics.emptyClicks,
          hitRate: metrics.hitRate,
          avgIntervalMs: metrics.avgIntervalMs,
          intervalStdMs: metrics.intervalStdMs,
          avgReactionMs: metrics.avgReactionMs,
          reactionStdMs: metrics.reactionStdMs,
          fastestReactionMs: metrics.fastestReactionMs,
          longestHitStreak: metrics.longestHitStreak,
          suspicionScore,
          suspicionReasons: reasons,
          invalidated: false,
          invalidReason: null,
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

    if (serverScore >= 500 || suspicionScore >= 4) {
      console.warn('🟠 SUSPICIOUS BUT COUNTED GAME', {
        userId,
        gameId,
        durationMs,
        serverScore,
        clientScore,
        suspicionScore,
        reasons,
        metrics,
      });
    }

    let referralRewardTickets = 0;

    const finishedCount = await this.prisma.game.count({
      where: {
        userId,
        finishedAt: { not: null },
        score: { gt: 0 },
        invalidated: false,
      },
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
      mode: 'v2',
      game: updatedGame,
      serverScore,
      clientScore,
      scoreDelta,

      starsEarned,
      totalStars: updatedUser.stars,

      level: updatedUser.level,
      xp: updatedUser.xp,
      xpGained,
      leveledUp,

      melasCount: metrics.melasHits,
      meatEarned,
      totalMeat: updatedUser.meat,

      suspicionScore,
      suspicionReasons: reasons,

      emptyClicks: metrics.emptyClicks,
      hitRate: metrics.hitRate,
      avgIntervalMs: metrics.avgIntervalMs,
      intervalStdMs: metrics.intervalStdMs,
      avgReactionMs: metrics.avgReactionMs,
      reactionStdMs: metrics.reactionStdMs,
      fastestReactionMs: metrics.fastestReactionMs,
      longestHitStreak: metrics.longestHitStreak,

      referralRewardTickets,
    };
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
          finishedAt: { gte: startOfDay },
          invalidated: false,
        },
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
          finishedAt: { gte: startOfDay },
          invalidated: false,
        },
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
    if (alreadyClaimed) {
      throw new BadRequestException('Reward already claimed today');
    }

    userData.stars = { increment: reward };

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: userData,
      select: { stars: true },
    });

    return {
      questId,
      reward,
      stars: updatedUser.stars,
    };
  }
}
