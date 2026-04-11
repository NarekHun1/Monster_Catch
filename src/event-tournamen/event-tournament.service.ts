// src/event-tournamen/event-tournament.service.ts
import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { Prisma, TournamentStatus } from '@prisma/client';

interface JwtPayload {
  userId: number;
}

type EventTournamentConfig = {
  slug: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  joinDeadline: Date;
  entryFee: number;
  prizePool: number;
  coinsOnly?: boolean;
};

@Injectable()
export class EventTournamentService {
  private readonly logger = new Logger(EventTournamentService.name);
  private readonly REPLAY_PRICES = [10, 15, 20];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  // ───────────────── AUTH ─────────────────
  private getUserIdFromToken(authHeader?: string): number {
    const token = (authHeader ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) throw new UnauthorizedException('Token missing');

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret) throw new UnauthorizedException('JWT secret missing');

    try {
      const payload = jwt.verify(token, secret) as JwtPayload;
      return payload.userId;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }

  // ───────────────── HELPERS ─────────────────
  private getNextReplayPrice(replayCount: number): number | null {
    return replayCount < this.REPLAY_PRICES.length
      ? this.REPLAY_PRICES[replayCount]
      : null;
  }

  private getAttemptsLeft(replayCount: number, usedAttempts: number): number {
    const totalAttempts = 1 + replayCount;
    return Math.max(0, totalAttempts - usedAttempts);
  }

  // ───────────────── TELEGRAM ─────────────────
  private async safeSendTelegramMessage(telegramId: string, text: string) {
    try {
      await this.bot.telegram.sendMessage(telegramId, text);
    } catch (e) {
      this.logger.warn(`Failed to send message to ${telegramId}: ${String(e)}`);
    }
  }

  private formatPlace(place: number) {
    if (place === 1) return '🥇 1 место';
    if (place === 2) return '🥈 2 место';
    if (place === 3) return '🥉 3 место';
    return `#${place}`;
  }

  // ───────────────── CONFIG ─────────────────
  private getEventConfigs(): EventTournamentConfig[] {
    const startsAt = new Date();

    const endsAt = new Date();
    endsAt.setDate(endsAt.getDate() + 5);

    const joinDeadline = endsAt;

    return [
      {
        slug: 'monster-april-2026',
        title: '🔥 MONSTER CATCH TOURNAMENT',
        startsAt,
        endsAt,
        joinDeadline,
        entryFee: 80,
        prizePool: 3340,
        coinsOnly: true,
      },
    ];
  }

  private getConfigBySlug(slug: string): EventTournamentConfig {
    const cfg = this.getEventConfigs().find((x) => x.slug === slug);
    if (!cfg) throw new BadRequestException('Unknown event slug');
    return cfg;
  }

  // ───────────────── FIXED PRIZES TOP-7 ─────────────────
  private getFixedPrizes(): number[] {
    return [1670, 668, 334, 167, 167, 167, 167];
  }

  // ───────────────── DAILY NOTICE ─────────────────
  async checkDailyEventNotice(authHeader: string, slug: string) {
    const userId = this.getUserIdFromToken(authHeader);
    const cfg = this.getConfigBySlug(slug);
    const t = await this.getOrCreateEventTournament(cfg);

    const now = new Date();

    if (
      t.status !== TournamentStatus.ACTIVE ||
      now >= t.endsAt ||
      now > t.joinDeadline
    ) {
      return {
        showNotice: false,
        reason: 'tournament_inactive',
      };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        lastEventNoticeDate: true,
      },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const alreadyJoined = await this.prisma.tournamentParticipant.findUnique({
      where: {
        userId_tournamentId: {
          userId,
          tournamentId: t.id,
        },
      },
    });

    if (alreadyJoined) {
      return {
        showNotice: false,
        reason: 'already_joined',
      };
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const alreadyShownToday =
      !!user.lastEventNoticeDate && user.lastEventNoticeDate >= startOfToday;

    if (alreadyShownToday) {
      return {
        showNotice: false,
        reason: 'already_shown_today',
      };
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        lastEventNoticeDate: now,
      },
    });

    return {
      showNotice: true,
      reason: 'show_first_time_today',
      tournament: {
        tournamentId: t.id,
        slug: t.slug,
        title: (t.rulesJson as any)?.title ?? cfg.title,
        entryFee: t.entryFee,
        prizePool: t.prizePool,
        endsAt: t.endsAt,
      },
    };
  }

  // ───────────────── CREATE / GET ─────────────────
  private async getOrCreateEventTournament(cfg: EventTournamentConfig) {
    const now = new Date();

    if (now >= cfg.endsAt) {
      throw new BadRequestException('Event already ended');
    }

    const existing = await this.prisma.tournament.findFirst({
      where: {
        slug: cfg.slug,
        status: { in: [TournamentStatus.PLANNED, TournamentStatus.ACTIVE] },
        endsAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      if (
        existing.status === TournamentStatus.PLANNED &&
        now >= existing.startsAt
      ) {
        return this.prisma.tournament.update({
          where: { id: existing.id },
          data: { status: TournamentStatus.ACTIVE },
        });
      }
      return existing;
    }

    const status =
      now >= cfg.startsAt ? TournamentStatus.ACTIVE : TournamentStatus.PLANNED;

    return this.prisma.tournament.create({
      data: {
        type: 'DAILY',
        slug: cfg.slug,
        rulesJson: {
          title: cfg.title,
          coinsOnly: !!cfg.coinsOnly,
          fixedPrizes: {
            1: 1670,
            2: 668,
            3: 334,
            4: 167,
            5: 167,
            6: 167,
            7: 167,
          },
        } as Prisma.InputJsonValue,
        startsAt: cfg.startsAt,
        endsAt: cfg.endsAt,
        joinDeadline: cfg.joinDeadline,
        entryFee: cfg.entryFee,
        prizePool: cfg.prizePool,
        status,
      },
    });
  }

  // ───────────────── PUBLIC API ─────────────────
  async getCurrentEvent(slug: string, authHeader?: string) {
    const cfg = this.getConfigBySlug(slug);
    const t = await this.getOrCreateEventTournament(cfg);

    const now = new Date();

    let joined = false;
    let coins = 0;
    let userId: number | null = null;

    let replayCount = 0;
    let usedAttempts = 0;
    let attemptsLeft = 0;
    let nextReplayPrice: number | null = null;
    let bestScore = 0;

    if (authHeader) {
      try {
        userId = this.getUserIdFromToken(authHeader);

        const participant = await this.prisma.tournamentParticipant.findUnique({
          where: {
            userId_tournamentId: {
              userId,
              tournamentId: t.id,
            },
          },
        });

        joined = !!participant;

        if (participant) {
          replayCount = participant.replayCount ?? 0;
          usedAttempts = participant.usedAttempts ?? 0;
          bestScore = participant.score ?? 0;
          attemptsLeft = this.getAttemptsLeft(replayCount, usedAttempts);
          nextReplayPrice = this.getNextReplayPrice(replayCount);
        }

        const u = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });
        coins = u?.coins ?? 0;
      } catch {
        // optional auth ignore
      }
    }

    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId: t.id },
      include: {
        user: {
          select: {
            telegramId: true,
            username: true,
            firstName: true,
          },
        },
      },
      orderBy: [{ score: 'desc' }, { createdAt: 'asc' }],
      take: 50,
    });

    const timeLeftMs = Math.max(0, t.endsAt.getTime() - now.getTime());
    const joinLeftMs = Math.max(0, t.joinDeadline.getTime() - now.getTime());

    const rules = t.rulesJson as any;
    const title = rules?.title ?? 'Event Tournament';

    const fixedPrizes = this.getFixedPrizes();

    return {
      tournamentId: t.id,
      slug: t.slug,
      title,
      status: t.status,
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      joinDeadline: t.joinDeadline,
      entryFee: t.entryFee,
      prizePool: t.prizePool,
      fixedPrizes,
      timeLeftMs,
      timeLeftSec: Math.ceil(timeLeftMs / 1000),
      joinLeftMs,
      joinLeftSec: Math.ceil(joinLeftMs / 1000),
      joined,
      coins,
      replayCount,
      usedAttempts,
      attemptsLeft,
      nextReplayPrice,
      bestScore,
      participants: participants.map((p, index) => ({
        place: index + 1,
        userId: p.userId,
        username: p.user.username ?? p.user.firstName ?? null,
        score: p.score,
        prize: index < fixedPrizes.length ? fixedPrizes[index] : 0,
      })),
    };
  }

  async joinEvent(authHeader: string, slug: string) {
    const userId = this.getUserIdFromToken(authHeader);
    const cfg = this.getConfigBySlug(slug);
    const t = await this.getOrCreateEventTournament(cfg);

    const now = new Date();

    if (t.status !== TournamentStatus.ACTIVE || now >= t.endsAt) {
      throw new BadRequestException('Tournament not active');
    }

    if (now > t.joinDeadline) {
      throw new BadRequestException('Join deadline passed');
    }

    return this.prisma.$transaction(async (tx) => {
      const exists = await tx.tournamentParticipant.findUnique({
        where: { userId_tournamentId: { userId, tournamentId: t.id } },
      });

      if (exists) {
        return { joined: false, tournamentId: t.id, slug };
      }

      const u = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true, isBlocked: true },
      });

      if (!u) throw new BadRequestException('User not found');
      if (u.isBlocked) throw new BadRequestException('User blocked');
      if (u.coins < t.entryFee) {
        throw new BadRequestException('Not enough coins');
      }

      await tx.user.update({
        where: { id: userId },
        data: { coins: { decrement: t.entryFee } },
      });

      await tx.tournamentParticipant.create({
        data: {
          userId,
          tournamentId: t.id,
          score: 0,
          payWith: 'coins',
          replayCount: 0,
          usedAttempts: 0,
        },
      });

      return { joined: true, tournamentId: t.id, slug };
    });
  }

  async buyReplay(authHeader: string, tournamentId: number) {
    const userId = this.getUserIdFromToken(authHeader);

    const t = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });

    if (!t) {
      throw new BadRequestException('Tournament not found');
    }

    if (t.status !== TournamentStatus.ACTIVE || new Date() >= t.endsAt) {
      throw new BadRequestException('Tournament not active');
    }

    const participant = await this.prisma.tournamentParticipant.findUnique({
      where: {
        userId_tournamentId: {
          userId,
          tournamentId,
        },
      },
    });

    if (!participant) {
      throw new BadRequestException('You are not joined');
    }

    const replayCount = participant.replayCount ?? 0;
    const usedAttempts = participant.usedAttempts ?? 0;
    const attemptsLeft = this.getAttemptsLeft(replayCount, usedAttempts);

    if (attemptsLeft > 0) {
      throw new BadRequestException('You still have attempts left');
    }

    const nextPrice = this.getNextReplayPrice(replayCount);

    if (nextPrice === null) {
      throw new BadRequestException('Replay limit reached');
    }

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true, isBlocked: true },
      });

      if (!user) {
        throw new BadRequestException('User not found');
      }

      if (user.isBlocked) {
        throw new BadRequestException('User blocked');
      }

      if (user.coins < nextPrice) {
        throw new BadRequestException(
          `Need ${nextPrice - user.coins} more coins`,
        );
      }

      await tx.user.update({
        where: { id: userId },
        data: {
          coins: { decrement: nextPrice },
        },
      });

      await tx.tournamentParticipant.update({
        where: { id: participant.id },
        data: {
          replayCount: { increment: 1 },
        },
      });

      return {
        success: true,
        replayPrice: nextPrice,
      };
    });
  }

  async submitScore(authHeader: string, slug: string, score: number) {
    const userId = this.getUserIdFromToken(authHeader);
    const cfg = this.getConfigBySlug(slug);
    const t = await this.getOrCreateEventTournament(cfg);

    if (t.status !== TournamentStatus.ACTIVE || new Date() >= t.endsAt) {
      return { updated: false };
    }

    const p = await this.prisma.tournamentParticipant.findUnique({
      where: { userId_tournamentId: { userId, tournamentId: t.id } },
    });

    if (!p) return { updated: false };

    const replayCount = p.replayCount ?? 0;
    const usedAttempts = p.usedAttempts ?? 0;
    const attemptsLeft = this.getAttemptsLeft(replayCount, usedAttempts);

    if (attemptsLeft <= 0) {
      return { updated: false, reason: 'NO_ATTEMPTS_LEFT' };
    }

    const currentBest = p.score ?? 0;
    const newBest = score > currentBest ? score : currentBest;

    await this.prisma.tournamentParticipant.update({
      where: { id: p.id },
      data: {
        usedAttempts: { increment: 1 },
        score: newBest,
      },
    });

    return {
      updated: true,
      bestScore: newBest,
      attemptsLeft: this.getAttemptsLeft(replayCount, usedAttempts + 1),
    };
  }

  // ───────────────── DAILY REMINDER ─────────────────
  @Cron(CronExpression.EVERY_DAY_AT_NOON)
  async notifyUsersAboutTournament() {
    try {
      const cfg = this.getConfigBySlug('monster-april-2026');
      const t = await this.getOrCreateEventTournament(cfg);

      if (t.status !== TournamentStatus.ACTIVE || new Date() >= t.endsAt) {
        return;
      }

      const users = await this.prisma.user.findMany({
        select: {
          id: true,
          telegramId: true,
          firstName: true,
          username: true,
        },
      });

      for (const user of users) {
        if (!user.telegramId) continue;

        const joined = await this.prisma.tournamentParticipant.findUnique({
          where: {
            userId_tournamentId: {
              userId: user.id,
              tournamentId: t.id,
            },
          },
        });

        if (!joined) {
          await this.safeSendTelegramMessage(
            String(user.telegramId),
            `🔥 Новый турнир уже идёт!\n\n` +
            `🏆 ${cfg.title}\n` +
            `💰 Призовой фонд: ${cfg.prizePool} coin\n` +
            `🎟 Вход: ${cfg.entryFee} coin\n` +
            `⏳ Длительность: 5 дней\n\n` +
            `Залетай и поборись за топ-7 🚀`,
          );
        } else {
          await this.safeSendTelegramMessage(
            String(user.telegramId),
            `🏆 Турнир продолжается!\n\n` +
            `${cfg.title}\n` +
            `Твой результат уже сохранён, но ты ещё можешь улучшить счёт 🔥\n\n` +
            `Зайди в игру и поднимись выше в таблице лидеров 🚀`,
          );
        }
      }

      this.logger.log(
        `Daily tournament notifications sent for slug=${cfg.slug}`,
      );
    } catch (e) {
      this.logger.warn(`notifyUsersAboutTournament failed: ${String(e)}`);
    }
  }

  // ───────────────── CRON FINISH ─────────────────
  @Cron(CronExpression.EVERY_MINUTE)
  async finishExpiredEventTournaments() {
    const now = new Date();

    const candidates = await this.prisma.tournament.findMany({
      where: {
        slug: { not: null },
        status: TournamentStatus.ACTIVE,
        endsAt: { lte: now },
      },
      select: { id: true, slug: true, prizePool: true },
      take: 50,
    });

    let finishedCount = 0;

    for (const c of candidates) {
      const claimed = await this.prisma.tournament.updateMany({
        where: { id: c.id, status: TournamentStatus.ACTIVE },
        data: { status: TournamentStatus.FINISHED },
      });

      if (claimed.count === 0) continue;

      finishedCount++;

      const t = await this.prisma.tournament.findUnique({
        where: { id: c.id },
        include: {
          participants: {
            include: {
              user: {
                select: {
                  telegramId: true,
                  username: true,
                  firstName: true,
                },
              },
            },
          },
        },
      });

      if (!t) continue;

      const rules = t.rulesJson as any;
      const title = rules?.title ?? 'Event Tournament';

      const participants = t.participants ?? [];
      if (participants.length === 0) continue;

      const sorted = [...participants].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.createdAt.getTime() - b.createdAt.getTime();
      });

      const fixedPrizes = this.getFixedPrizes();

      const winners: Array<{ userId: number; place: number; prize: number }> =
        [];

      for (let i = 0; i < fixedPrizes.length; i++) {
        if (sorted[i]) {
          winners.push({
            userId: sorted[i].userId,
            place: i + 1,
            prize: fixedPrizes[i],
          });
        }
      }

      await this.prisma.$transaction(
        winners
          .filter((w) => w.prize > 0)
          .map((w) =>
            this.prisma.user.update({
              where: { id: w.userId },
              data: { coins: { increment: w.prize } },
            }),
          ),
      );

      const prizeByUserId = new Map<number, { prize: number; place: number }>();
      for (const w of winners) {
        prizeByUserId.set(w.userId, { prize: w.prize, place: w.place });
      }

      for (let i = 0; i < sorted.length; i++) {
        const p = sorted[i];
        const place = i + 1;

        const telegramId = p.user?.telegramId;
        if (!telegramId) continue;

        const prizeInfo = prizeByUserId.get(p.userId);
        const prize = prizeInfo?.prize ?? 0;

        const text =
          `🏁 Турнир завершён!\n` +
          `${title}\n\n` +
          `Ваше место: ${this.formatPlace(place)}\n` +
          `Ваш результат: ${p.score}\n` +
          (prize > 0
            ? `Ваш приз: 🪙 ${prize}\n\nПоздравляем! 🚀`
            : `Вы не попали в призовые места.\n\nПопробуйте снова в следующем турнире! 🔥`);

        await this.safeSendTelegramMessage(String(telegramId), text);
      }

      this.logger.log(
        `Event tournament finished: slug=${t.slug} id=${t.id} participants=${sorted.length}`,
      );
    }

    return finishedCount;
  }
}