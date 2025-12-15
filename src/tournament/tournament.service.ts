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

export type TournamentType = 'HOURLY' | 'DAILY';

@Injectable()
export class TournamentService {
  private readonly logger = new Logger(TournamentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  // ─────────────────────────────────────────────
  // AUTH
  // ─────────────────────────────────────────────
  private getUserIdFromToken(token: string): number {
    if (!token) throw new UnauthorizedException('Token missing');

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret) throw new UnauthorizedException('JWT secret missing');

    try {
      const payload = jwt.verify(token, secret) as JwtPayload;
      if (!payload.userId) throw new UnauthorizedException();
      return payload.userId;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }

  // ─────────────────────────────────────────────
  // DATE HELPERS
  // ─────────────────────────────────────────────
  private floorToHour(date: Date): Date {
    const d = new Date(date);
    d.setMinutes(0, 0, 0);
    return d;
  }

  private floorToDay(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // ─────────────────────────────────────────────
  // CREATE OR GET TOURNAMENT
  // ─────────────────────────────────────────────
  async getOrCreateTournament(type: TournamentType) {
    const now = new Date();

    let startsAt: Date;
    let joinDeadline: Date;
    let endsAt: Date;
    let entryFee = 50;

    if (type === 'HOURLY') {
      // ✅ ТЕКУЩИЙ ЧАС
      startsAt = this.floorToHour(now);

      joinDeadline = new Date(startsAt);
      joinDeadline.setMinutes(10, 0, 0); // вход 10 мин

      endsAt = new Date(startsAt);
      endsAt.setMinutes(20, 0, 0); // игра 20 мин
    } else {
      // ✅ DAILY — ВЕСЬ ДЕНЬ
      startsAt = this.floorToDay(now);

      endsAt = new Date(startsAt);
      endsAt.setHours(23, 59, 59, 999);

      joinDeadline = endsAt; // 🔥 вход весь день
      entryFee = 100;
    }

    let tournament = await this.prisma.tournament.findFirst({
      where: { type, startsAt },
    });

    if (!tournament) {
      tournament = await this.prisma.tournament.create({
        data: {
          type,
          startsAt,
          joinDeadline,
          endsAt,
          entryFee,
          status: 'ACTIVE',
          prizePool: 0,
        },
      });
    }

    return tournament;
  }

  // ─────────────────────────────────────────────
  // JOIN TOURNAMENT
  // ─────────────────────────────────────────────
  async join(token: string, type: TournamentType, entry: 'TICKET' | 'COINS') {
    const userId = this.getUserIdFromToken(token);
    const now = new Date();

    const tournament = await this.getOrCreateTournament(type);

    if (tournament.status === 'FINISHED') {
      throw new BadRequestException('Tournament finished');
    }

    if (type === 'HOURLY' && now > tournament.joinDeadline) {
      throw new BadRequestException('Join window closed');
    }

    const existing = await this.prisma.tournamentParticipant.findUnique({
      where: {
        userId_tournamentId: {
          userId,
          tournamentId: tournament.id,
        },
      },
    });

    if (existing) {
      return { joined: false, tournamentId: tournament.id };
    }

    // ─────────────────────────────
    // 🎟 ВХОД ЗА БИЛЕТ
    // ─────────────────────────────
    if (entry === 'TICKET') {
      const ticket = await this.prisma.ticket.findFirst({
        where: { userId, usedAt: null },
        orderBy: { createdAt: 'asc' },
      });

      if (!ticket) {
        throw new BadRequestException('Not enough tickets');
      }

      await this.prisma.$transaction([
        this.prisma.ticket.update({
          where: { id: ticket.id },
          data: { usedAt: new Date() },
        }),
        this.prisma.tournamentParticipant.create({
          data: {
            userId,
            tournamentId: tournament.id,
            score: 0,
          },
        }),
      ]);

      return {
        joined: true,
        method: 'TICKET',
        tournamentId: tournament.id,
      };
    }

    // ─────────────────────────────
    // 🪙 ВХОД ЗА COINS
    // ─────────────────────────────
    if (entry === 'COINS') {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });

      if (!user || user.coins < tournament.entryFee) {
        throw new BadRequestException('Not enough coins');
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
          data: {
            userId,
            tournamentId: tournament.id,
            score: 0,
          },
        }),
      ]);

      return {
        joined: true,
        method: 'COINS',
        coinsLeft: user.coins - tournament.entryFee,
        tournamentId: tournament.id,
      };
    }

    throw new BadRequestException('Invalid entry method');
  }

  // ─────────────────────────────────────────────
  // SUBMIT SCORE (ONLY ONCE)
  // ─────────────────────────────────────────────
  async submitScore(token: string, type: TournamentType, score: number) {
    const userId = this.getUserIdFromToken(token);
    const tournament = await this.getOrCreateTournament(type);

    const participant = await this.prisma.tournamentParticipant.findUnique({
      where: {
        userId_tournamentId: {
          userId,
          tournamentId: tournament.id,
        },
      },
    });

    if (!participant) return { updated: false };

    if (participant.score !== 0) {
      return { updated: false }; // ❌ уже отправлял
    }

    await this.prisma.tournamentParticipant.update({
      where: { id: participant.id },
      data: { score },
    });

    return { updated: true };
  }

  // ─────────────────────────────────────────────
  // CRON — FINISH TOURNAMENTS
  // ─────────────────────────────────────────────
  @Cron(CronExpression.EVERY_MINUTE)
  async handleFinishCron() {
    const finishedCount = await this.finishExpiredTournaments();
    if (finishedCount > 0) {
      this.logger.log(`Finished ${finishedCount} tournaments`);
    }
  }

  // ─────────────────────────────────────────────
  // FINISH LOGIC
  // ─────────────────────────────────────────────
  async finishExpiredTournaments(): Promise<number> {
    const now = new Date();

    const tournaments = await this.prisma.tournament.findMany({
      where: {
        status: 'ACTIVE',
        endsAt: { lte: now },
      },
      include: {
        participants: { include: { user: true } },
      },
    });

    for (const t of tournaments) {
      const participants = [...t.participants].sort(
        (a, b) => b.score - a.score,
      );

      const count = participants.length;
      const prizePool = t.prizePool;
      const entryFee = t.entryFee;

      const tx: Prisma.PrismaPromise<any>[] = [];
      const prizes: number[] = [];

      // 1 игрок — возврат
      if (count === 1) {
        prizes.push(entryFee);
        tx.push(
          this.prisma.user.update({
            where: { id: participants[0].userId },
            data: { coins: { increment: entryFee } },
          }),
        );
      }

      // 2–3 игрока — 50 первому
      else if (count === 2 || count === 3) {
        prizes.push(50);
        tx.push(
          this.prisma.user.update({
            where: { id: participants[0].userId },
            data: { coins: { increment: 50 } },
          }),
        );
      }

      // 4+ игроков — 40% / 50 / 50
      else {
        prizes.push(Math.floor(prizePool * 0.4), 50, 50);

        participants.slice(0, 3).forEach((p, i) => {
          tx.push(
            this.prisma.user.update({
              where: { id: p.userId },
              data: { coins: { increment: prizes[i] } },
            }),
          );
        });
      }

      tx.push(
        this.prisma.tournament.update({
          where: { id: t.id },
          data: { status: 'FINISHED' },
        }),
      );

      await this.prisma.$transaction(tx);

      // 📩 Telegram notify
      for (let i = 0; i < prizes.length && i < participants.length; i++) {
        const p = participants[i];
        if (!p?.user?.telegramId) continue;

        await this.bot.telegram.sendMessage(
          Number(p.user.telegramId),
          `🏆 Турнир завершён!\n\nМесто: ${i + 1}\nОчки: ${
            p.score
          }\nНаграда: ${prizes[i]} 🪙`,
        );
      }
    }

    return tournaments.length;
  }

  // ─────────────────────────────────────────────
  // CURRENT / LEADERBOARD
  // ─────────────────────────────────────────────
  async getCurrentTournament(type: TournamentType, token?: string) {
    const tournament = await this.getOrCreateTournament(type);

    let joined = false;
    let coins = 0;
    let ticketsCount = 0;

    let userId: number | null = null;

    if (token) {
      try {
        userId = this.getUserIdFromToken(token);

        const existing = await this.prisma.tournamentParticipant.findUnique({
          where: {
            userId_tournamentId: {
              userId,
              tournamentId: tournament.id,
            },
          },
        });

        joined = !!existing;

        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });

        coins = user?.coins ?? 0;

        ticketsCount = await this.prisma.ticket.count({
          where: {
            userId,
            usedAt: null,
          },
        });
      } catch {
        // токен невалидный — просто считаем как гость
      }
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

      // 👤 META ДЛЯ ТЕКУЩЕГО ПОЛЬЗОВАТЕЛЯ
      joined,
      coins,
      ticketsCount,

      // 🏆 УЧАСТНИКИ
      participants: participants.map((p) => ({
        userId: p.userId,
        username: p.user.username ?? p.user.firstName ?? null,
        score: p.score,
      })),
    };
  }

}
