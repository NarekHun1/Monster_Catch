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
      joinDeadline = new Date(startsAt);
      joinDeadline.setMinutes(10, 0, 0);
      endsAt = new Date(startsAt);
      endsAt.setMinutes(20, 0, 0);
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
  async join(token: string, type: TournamentType) {
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

    // 💰 CASH CUP (tickets OR coins → prizePool)
    if (tournament.type === 'CASH_CUP') {
      const ticket = await this.prisma.ticket.findFirst({
        where: { userId, usedAt: null },
        orderBy: { createdAt: 'asc' },
      });

      // 🎟 Вход по билету
      if (ticket) {
        await this.prisma.$transaction([
          this.prisma.ticket.update({
            where: { id: ticket.id },
            data: { usedAt: new Date() },
          }),
          this.prisma.tournament.update({
            where: { id: tournament.id },
            data: { prizePool: { increment: tournament.entryFee } },
          }),
          this.prisma.tournamentParticipant.create({
            data: { userId, tournamentId: tournament.id },
          }),
        ]);

        return { joined: true, tournamentId: tournament.id, via: 'ticket' };
      }

      // 🪙 fallback coins
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { coins: true },
      });

      if (!user || user.coins < tournament.entryFee) {
        throw new BadRequestException('Not enough tickets or coins');
      }

      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: userId },
          data: { coins: { decrement: tournament.entryFee } },
        }),
        this.prisma.tournament.update({
          where: { id: tournament.id },
          data: { prizePool: { increment: tournament.entryFee } },
        }),
        this.prisma.tournamentParticipant.create({
          data: { userId, tournamentId: tournament.id },
        }),
      ]);

      return { joined: true, tournamentId: tournament.id, via: 'coins' };
    }

    // 🎟 DAILY / HOURLY ticket entry
    const ticket = await this.prisma.ticket.findFirst({
      where: { userId, usedAt: null },
    });
    if (ticket) {
      await this.prisma.$transaction([
        this.prisma.ticket.update({
          where: { id: ticket.id },
          data: { usedAt: new Date() },
        }),
        this.prisma.tournamentParticipant.create({
          data: { userId, tournamentId: tournament.id },
        }),
      ]);
      return { joined: true, tournamentId: tournament.id };
    }

    // 🪙 fallback coins
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.coins < tournament.entryFee) {
      throw new BadRequestException('Not enough coins');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { coins: { decrement: tournament.entryFee } },
      }),
      this.prisma.tournamentParticipant.create({
        data: { userId, tournamentId: tournament.id },
      }),
    ]);

    return { joined: true, tournamentId: tournament.id };
  }

  // ───────────────── SUBMIT SCORE ─────────────────
  async submitScore(token: string, type: TournamentType, score: number) {
    const userId = this.getUserIdFromToken(token);
    const tournament = await this.getOrCreateTournament(type);

    if (new Date() > tournament.endsAt) return { updated: false };

    const p = await this.prisma.tournamentParticipant.findUnique({
      where: {
        userId_tournamentId: { userId, tournamentId: tournament.id },
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
      include: { participants: true },
    });

    for (const t of tournaments) {
      const sorted = [...t.participants].sort((a, b) => b.score - a.score);
      let prizes: number[] = [];

      if (t.type === 'CASH_CUP') {
        prizes = this.calculateCashCupPrizes(t.prizePool, sorted.length);
      } else {
        if (sorted.length === 1) prizes = [t.entryFee];
        else if (sorted.length >= 2) prizes = [50];
      }

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

    return {
      tournamentId: tournament.id,
      type: tournament.type,
      status: tournament.status,
      startsAt: tournament.startsAt,
      endsAt: tournament.endsAt,
      joinDeadline: tournament.joinDeadline,
      entryFee: tournament.entryFee,
      prizePool: tournament.prizePool,

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
