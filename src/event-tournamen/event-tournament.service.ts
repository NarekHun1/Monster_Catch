// src/event-tournament/event-tournament.service.ts
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
    /**
     * Example:
     * 1 March 2026 00:00 Yerevan (UTC+4) = 2026-02-29 20:00:00Z
     */
    const startsAt = new Date(); // "start now"
    const endsAt = new Date('2026-02-29T20:00:00.000Z'); // 1 Mar 2026 00:00 Yerevan
    const joinDeadline = endsAt; // allow join until end (you can set earlier)

    return [
      {
        slug: 'big-march-2026',
        title: '🏆 BIG MARCH',
        startsAt,
        endsAt,
        joinDeadline,
        entryFee: 100,
        prizePool: 10_000,
        coinsOnly: true,
      },
    ];
  }

  private getConfigBySlug(slug: string): EventTournamentConfig {
    const cfg = this.getEventConfigs().find((x) => x.slug === slug);
    if (!cfg) throw new BadRequestException('Unknown event slug');
    return cfg;
  }

  // ───────────────── PRIZES 40/20/10 ─────────────────
  private calculatePercentPrizes(prizePool: number): [number, number, number] {
    const p1 = Math.floor(prizePool * 0.4);
    const p2 = Math.floor(prizePool * 0.2);
    const p3 = Math.floor(prizePool * 0.1);
    return [p1, p2, p3];
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
      // auto-activate when startsAt passed
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

    // Keep type as an existing enum (so we don't touch your old system)
    return this.prisma.tournament.create({
      data: {
        type: 'DAILY',
        slug: cfg.slug,
        rulesJson: {
          title: cfg.title,
          coinsOnly: !!cfg.coinsOnly,
          percentPrizes: { first: 0.4, second: 0.2, third: 0.1 },
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

    if (authHeader) {
      try {
        userId = this.getUserIdFromToken(authHeader);

        joined = !!(await this.prisma.tournamentParticipant.findUnique({
          where: { userId_tournamentId: { userId, tournamentId: t.id } },
        }));

        const u = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });
        coins = u?.coins ?? 0;
      } catch {
        // ignore optional auth
      }
    }

    // only fetch minimal user fields
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
      timeLeftMs,
      timeLeftSec: Math.ceil(timeLeftMs / 1000),
      joinLeftMs,
      joinLeftSec: Math.ceil(joinLeftMs / 1000),
      joined,
      coins,
      participants: participants.map((p) => ({
        userId: p.userId,
        username: p.user.username ?? p.user.firstName ?? null,
        score: p.score,
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
      if (exists) return { joined: false, tournamentId: t.id, slug };

      const u = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true, isBlocked: true },
      });
      if (!u) throw new BadRequestException('User not found');
      if (u.isBlocked) throw new BadRequestException('User blocked');
      if (u.coins < t.entryFee)
        throw new BadRequestException('Not enough coins');

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
        },
      });

      return { joined: true, tournamentId: t.id, slug };
    });
  }

  // submit max score (if score is higher, update)
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

    if (score <= p.score) return { updated: false };

    await this.prisma.tournamentParticipant.update({
      where: { id: p.id },
      data: { score },
    });

    return { updated: true };
  }

  // ───────────────── CRON FINISH ─────────────────
  /**
   * Safe finish:
   * - claims each tournament once (prevents double payouts on multi-instance)
   * - awards top-3 (40/20/10)
   * - sends Telegram to every participant
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async finishExpiredEventTournaments() {
    const now = new Date();

    // find candidates (may be claimed by other instances)
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
      // ✅ claim (only one instance will succeed)
      const claimed = await this.prisma.tournament.updateMany({
        where: { id: c.id, status: TournamentStatus.ACTIVE },
        data: { status: TournamentStatus.FINISHED },
      });
      if (claimed.count === 0) continue;

      finishedCount++;

      // load full data after claim
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

      const [p1, p2, p3] = this.calculatePercentPrizes(t.prizePool);

      const winners: Array<{ userId: number; place: number; prize: number }> =
        [];
      if (sorted[0])
        winners.push({ userId: sorted[0].userId, place: 1, prize: p1 });
      if (sorted[1])
        winners.push({ userId: sorted[1].userId, place: 2, prize: p2 });
      if (sorted[2])
        winners.push({ userId: sorted[2].userId, place: 3, prize: p3 });

      // ✅ pay winners (no tournament status update here — already finished by claim)
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
      for (const w of winners)
        prizeByUserId.set(w.userId, { prize: w.prize, place: w.place });

      // Notify every participant
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
          (place <= 3
            ? `Ваш приз: 🪙 ${prize}\n\nПоздравляем! 🚀`
            : `Приз получают только топ-3.\n\nПопробуйте снова! 🔥`);

        await this.safeSendTelegramMessage(String(telegramId), text);
      }

      this.logger.log(
        `Event tournament finished: slug=${t.slug} id=${t.id} participants=${sorted.length}`,
      );
    }

    return finishedCount;
  }
}
