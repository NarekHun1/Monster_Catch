import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { Prisma } from '@prisma/client';

interface JwtPayload {
  userId: number;
}

export type TournamentType = 'HOURLY' | 'DAILY' | 'CASH_CUP';

@Injectable()
export class TournamentService {
  private readonly logger = new Logger(TournamentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  // ───────────────── AUTH ─────────────────
  private getUserIdFromToken(token: string): number {
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
  private formatTournamentTitle(type: TournamentType) {
    if (type === 'HOURLY') return '⏱ HOURLY';
    if (type === 'DAILY') return '📅 DAILY';
    return '💰 CASH CUP';
  }

  private formatPlace(place: 1 | 2 | 3) {
    return place === 1
      ? '🥇 1 место'
      : place === 2
        ? '🥈 2 место'
        : '🥉 3 место';
  }

  private async safeSendTelegramMessage(telegramId: string, text: string) {
    try {
      await this.bot.telegram.sendMessage(telegramId, text);
    } catch (e) {
      this.logger.warn(`Failed to send message to ${telegramId}: ${String(e)}`);
    }
  }

  private async notifyWinner(args: {
    telegramId: string;
    type: TournamentType;
    place: 1 | 2 | 3;
    prize: number;
  }) {
    const { telegramId, type, place, prize } = args;

    const text =
      `🎉 Поздравляем!\n` +
      `${this.formatPlace(place)} в турнире ${this.formatTournamentTitle(type)}\n` +
      `Ваш приз: 🪙 ${prize}\n\n` +
      `Спасибо за игру! 🚀`;

    await this.safeSendTelegramMessage(telegramId, text);
  }

  // ───────────────── TIME HELPERS ─────────────────
  private floorToHour(d: Date) {
    const x = new Date(d);
    x.setMinutes(0, 0, 0);
    return x;
  }

  private floorToDay(d: Date) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
  }

  private floorTo30Minutes(d: Date) {
    const x = new Date(d);
    x.setSeconds(0, 0);
    x.setMinutes(x.getMinutes() < 30 ? 0 : 30);
    return x;
  }

  // ───────────────── CASH CUP PRIZES ─────────────────
  private calculateCashCupPrizes(prizePool: number, count: number): number[] {
    if (count === 0) return [];
    if (count === 1) return [prizePool];

    return [
      Math.floor(prizePool * 0.5),
      Math.floor(prizePool * 0.2),
      Math.floor(prizePool * 0.1),
    ];
  }

  // ───────────────── CREATE / GET ─────────────────
  async getOrCreateTournament(type: TournamentType) {
    const now = new Date();
    let startsAt: Date;
    let endsAt: Date;
    let joinDeadline: Date;
    let entryFee = 50;

    if (type === 'HOURLY') {
      startsAt = this.floorToHour(now);

      // ✅ длится 1 час
      endsAt = new Date(startsAt);
      endsAt.setHours(endsAt.getHours() + 1);

      // ✅ вход весь час
      joinDeadline = new Date(endsAt);

      entryFee = 50;
    } else if (type === 'DAILY') {
      startsAt = this.floorToDay(now);
      endsAt = new Date(startsAt);
      endsAt.setHours(23, 59, 59, 999);
      joinDeadline = endsAt;
      entryFee = 100;
    } else {
      startsAt = this.floorTo30Minutes(now);
      endsAt = new Date(startsAt);
      endsAt.setMinutes(endsAt.getMinutes() + 30);
      joinDeadline = endsAt;
      entryFee = 10;
    }

    let tournament = await this.prisma.tournament.findFirst({
      where: { type, startsAt },
    });

    if (!tournament) {
      tournament = await this.prisma.tournament.create({
        data: {
          type,
          startsAt,
          endsAt,
          joinDeadline,
          entryFee,
          prizePool: 0,
          status: 'ACTIVE',
        },
      });
    }

    return tournament;
  }

  // ───────────────── JOIN ─────────────────
  async join(
    token: string,
    type: TournamentType,
    payWith: 'coins' | 'tickets' = 'coins',
  ) {
    const userId = this.getUserIdFromToken(token);
    const tournament = await this.getOrCreateTournament(type);

    if (tournament.status === 'FINISHED') {
      throw new BadRequestException('Tournament finished');
    }

    const exists = await this.prisma.tournamentParticipant.findUnique({
      where: {
        userId_tournamentId: { userId, tournamentId: tournament.id },
      },
    });

    if (exists) return { joined: false, tournamentId: tournament.id };

    // ✅ CASH_CUP (10 tickets OR 10 coins) + prizePool
    if (tournament.type === 'CASH_CUP') {
      const REQUIRED = 10;

      if (payWith === 'tickets') {
        const tickets = await this.prisma.ticket.findMany({
          where: { userId, usedAt: null },
          orderBy: { createdAt: 'asc' },
          take: REQUIRED,
        });

        if (tickets.length < REQUIRED) {
          throw new BadRequestException('Need 10 tickets');
        }

        await this.prisma.$transaction([
          ...tickets.map((t) =>
            this.prisma.ticket.update({
              where: { id: t.id },
              data: { usedAt: new Date() },
            }),
          ),
          this.prisma.tournament.update({
            where: { id: tournament.id },
            data: { prizePool: { increment: REQUIRED } },
          }),
          this.prisma.tournamentParticipant.create({
            data: { userId, tournamentId: tournament.id },
          }),
        ]);

        return { joined: true, tournamentId: tournament.id, via: 'tickets' };
      }

      // payWith === 'coins'
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { coins: true },
      });

      if (!user || user.coins < REQUIRED) {
        throw new BadRequestException('Need 10 coins');
      }

      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: userId },
          data: { coins: { decrement: REQUIRED } },
        }),
        this.prisma.tournament.update({
          where: { id: tournament.id },
          data: { prizePool: { increment: REQUIRED } },
        }),
        this.prisma.tournamentParticipant.create({
          data: { userId, tournamentId: tournament.id },
        }),
      ]);

      return { joined: true, tournamentId: tournament.id, via: 'coins' };
    }

    // ✅ HOURLY / DAILY
    const REQUIRED = tournament.type === 'HOURLY' ? 50 : 100; // DAILY = 100

    if (payWith === 'tickets') {
      const tickets = await this.prisma.ticket.findMany({
        where: { userId, usedAt: null },
        orderBy: { createdAt: 'asc' },
        take: REQUIRED,
      });

      if (tickets.length < REQUIRED) {
        throw new BadRequestException(`Need ${REQUIRED} tickets`);
      }

      await this.prisma.$transaction([
        ...tickets.map((t) =>
          this.prisma.ticket.update({
            where: { id: t.id },
            data: { usedAt: new Date() },
          }),
        ),

        // ✅ ДОБАВИТЬ: увеличиваем призовой фонд
        this.prisma.tournament.update({
          where: { id: tournament.id },
          data: { prizePool: { increment: REQUIRED } },
        }),

        this.prisma.tournamentParticipant.create({
          data: { userId, tournamentId: tournament.id },
        }),
      ]);

      return { joined: true, tournamentId: tournament.id, via: 'tickets' };
    }

    // payWith === 'coins'
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { coins: true },
    });

    if (!user || user.coins < REQUIRED) {
      throw new BadRequestException(`Need ${REQUIRED} coins`);
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { coins: { decrement: REQUIRED } },
      }),

      // ✅ ДОБАВИТЬ: увеличиваем призовой фонд
      this.prisma.tournament.update({
        where: { id: tournament.id },
        data: { prizePool: { increment: REQUIRED } },
      }),

      this.prisma.tournamentParticipant.create({
        data: { userId, tournamentId: tournament.id },
      }),
    ]);

    return { joined: true, tournamentId: tournament.id, via: 'coins' };
  }

  // ───────────────── SUBMIT SCORE ─────────────────
  async submitScore(token: string, tournamentId: number, score: number) {
    const userId = this.getUserIdFromToken(token);

    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });

    if (
      !tournament ||
      tournament.status !== 'ACTIVE' ||
      new Date() > tournament.endsAt
    ) {
      return { updated: false };
    }

    const p = await this.prisma.tournamentParticipant.findUnique({
      where: {
        userId_tournamentId: { userId, tournamentId },
      },
    });

    if (!p || p.score !== 0) return { updated: false };

    await this.prisma.tournamentParticipant.update({
      where: { id: p.id },
      data: { score },
    });

    return { updated: true };
  }

  // ───────────────── FINISH ─────────────────
  @Cron(CronExpression.EVERY_MINUTE)
  async finishExpiredTournaments() {
    const tournaments = await this.prisma.tournament.findMany({
      where: { status: 'ACTIVE', endsAt: { lte: new Date() } },
      include: {
        participants: {
          include: {
            user: { select: { telegramId: true } },
          },
        },
      },
    });

    for (const t of tournaments) {
      const sorted = [...t.participants].sort((a, b) => b.score - a.score);

      // призы как у тебя
      let prizes: number[] = [];
      if (t.type === 'CASH_CUP') {
        prizes = this.calculateCashCupPrizes(t.prizePool, sorted.length);
      } else {
        if (sorted.length === 1) prizes = [t.entryFee];
        else if (sorted.length >= 2) prizes = [50];
      }

      // начислить + закрыть
      const tx: Prisma.PrismaPromise<any>[] = [];

      sorted.slice(0, prizes.length).forEach((p, i) => {
        tx.push(
          this.prisma.user.update({
            where: { id: p.userId },
            data: { coins: { increment: prizes[i] } },
          }),
        );
      });

      tx.push(
        this.prisma.tournament.update({
          where: { id: t.id },
          data: { status: 'FINISHED' },
        }),
      );

      await this.prisma.$transaction(tx);

      // ✅ уведомить топ-3 (только тем, у кого есть telegramId)
      const top = sorted.slice(0, Math.min(3, prizes.length));
      for (let i = 0; i < top.length; i++) {
        const tg = top[i].user?.telegramId;
        if (!tg) continue;

        await this.notifyWinner({
          telegramId: String(tg),
          type: t.type as TournamentType,
          place: (i + 1) as 1 | 2 | 3,
          prize: prizes[i],
        });
      }
    }

    return tournaments.length;
  }

  // ───────────────── CURRENT ─────────────────
  async getCurrentTournament(type: TournamentType, token?: string) {
    const tournament = await this.getOrCreateTournament(type);

    let joined = false;
    let coins = 0;
    let ticketsCount = 0;
    let userId: number | null = null;

    if (token) {
      try {
        userId = this.getUserIdFromToken(token);

        joined = !!(await this.prisma.tournamentParticipant.findUnique({
          where: {
            userId_tournamentId: {
              userId,
              tournamentId: tournament.id,
            },
          },
        }));

        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });

        coins = user?.coins ?? 0;

        ticketsCount = await this.prisma.ticket.count({
          where: { userId, usedAt: null },
        });
      } catch {}
    }

    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId: tournament.id },
      include: { user: true },
      orderBy: { score: 'desc' },
      take: 20,
    });
    const now = new Date();

    const timeLeftMs = Math.max(0, tournament.endsAt.getTime() - now.getTime());

    const joinLeftMs = Math.max(
      0,
      tournament.joinDeadline.getTime() - now.getTime(),
    );

    return {
      tournamentId: tournament.id,
      type: tournament.type,
      status: tournament.status,
      startsAt: tournament.startsAt,
      endsAt: tournament.endsAt,
      joinDeadline: tournament.joinDeadline,
      entryFee: tournament.entryFee,
      prizePool: tournament.prizePool,

      timeLeftMs,
      timeLeftSec: Math.ceil(timeLeftMs / 1000),
      joinLeftMs,
      joinLeftSec: Math.ceil(joinLeftMs / 1000),

      joined,
      coins,
      ticketsCount,

      participants: participants.map((p) => ({
        userId: p.userId,
        username: p.user.username ?? p.user.firstName ?? null,
        score: p.score,
      })),
    };
  }
}
