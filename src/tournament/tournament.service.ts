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

interface JwtPayload {
  userId: number;
}

type TournamentType = 'HOURLY' | 'DAILY';

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
      startsAt = this.floorToHour(now);

      joinDeadline = new Date(startsAt);
      joinDeadline.setMinutes(10, 0, 0);

      endsAt = new Date(startsAt);
      endsAt.setMinutes(20, 0, 0);
    } else {
      startsAt = this.floorToDay(now);

      joinDeadline = new Date(startsAt);
      joinDeadline.setHours(1, 0, 0);

      endsAt = new Date(startsAt);
      endsAt.setHours(23, 59, 59, 999);

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
        },
      });
    }

    return tournament;
  }

  // ─────────────────────────────────────────────
  // JOIN TOURNAMENT
  // ─────────────────────────────────────────────
  async join(token: string, type: TournamentType) {
    const userId = this.getUserIdFromToken(token);
    const now = new Date();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const tournament = await this.getOrCreateTournament(type);

    if (now > tournament.joinDeadline || tournament.status === 'FINISHED') {
      throw new BadRequestException('Join window closed');
    }

    if (user.coins < tournament.entryFee) {
      throw new BadRequestException('Not enough coins');
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

    const [updatedUser] = await this.prisma.$transaction([
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

    return {
      joined: true,
      coins: updatedUser.coins,
      tournamentId: tournament.id,
    };
  }
  // ─────────────────────────────────────────────
  // SUBMIT SCORE (HOURLY or DAILY)
  // ─────────────────────────────────────────────
  async submitScore(token: string, type: TournamentType, score: number) {
    const userId = this.getUserIdFromToken(token);

    const tournament = await this.getOrCreateTournament(type);

    await this.submitScoreInternal(userId, tournament.id, score);

    return { updated: true };
  }

  private async submitScoreInternal(
    userId: number,
    tournamentId: number,
    score: number,
  ) {
    const participant = await this.prisma.tournamentParticipant.findUnique({
      where: {
        userId_tournamentId: { userId, tournamentId },
      },
    });

    if (!participant) return;

    if (participant.score > 0) {
      return; // ❌ уже отправлял результат
    }

    await this.prisma.tournamentParticipant.update({
      where: { id: participant.id },
      data: { score },
    });

  }

  // ─────────────────────────────────────────────
  // CRON: FINISH TOURNAMENTS
  // ─────────────────────────────────────────────
  @Cron(CronExpression.EVERY_MINUTE)
  async handleFinishCron() {
    const finished = await this.finishExpiredTournaments();
    if (finished.length) {
      this.logger.log(`Finished ${finished.length} tournaments`);
    }
  }

  async finishExpiredTournaments() {
    const now = new Date();

    const tournaments = await this.prisma.tournament.findMany({
      where: {
        status: { in: ['PLANNED', 'ACTIVE'] },
        endsAt: { lte: now },
      },
      include: {
        participants: { include: { user: true } },
      },
    });

    for (const t of tournaments) {
      const sorted = [...t.participants].sort((a, b) => b.score - a.score);
      const [p1, p2, p3] = sorted;

      const pool = t.prizePool;
      const fee = t.entryFee;

      const prizes = [p1 && Math.floor(pool * 0.4), p2 && fee, p3 && fee];

      const tx: any[] = [];

      [p1, p2, p3].forEach((p, i) => {
        if (p && prizes[i] > 0) {
          tx.push(
            this.prisma.user.update({
              where: { id: p.userId },
              data: { coins: { increment: prizes[i] } },
            }),
          );
        }
      });

      await this.prisma.$transaction([
        ...tx,
        this.prisma.tournament.update({
          where: { id: t.id },
          data: { status: 'FINISHED' },
        }),
      ]);

      // Telegram notify
      for (let i = 0; i < 3; i++) {
        const p = sorted[i];
        if (!p?.user?.telegramId) continue;

        try {
          await this.bot.telegram.sendMessage(
            Number(p.user.telegramId),
            `🏆 Турнир завершён!\n\nМесто: ${i + 1}\nОчки: ${
              p.score
            }\nНаграда: ${prizes[i]} 🪙`,
          );
        } catch {
          this.logger.warn(`Notify failed user ${p.userId}`);
        }
      }
    }

    return tournaments;
  }

  // ─────────────────────────────────────────────
  // LEADERBOARD
  // ─────────────────────────────────────────────
  async getCurrentTournament(type: TournamentType, token?: string) {
    const tournament = await this.getOrCreateTournament(type);

    let joined = false;

    if (token) {
      try {
        const userId = this.getUserIdFromToken(token);
        const existing = await this.prisma.tournamentParticipant.findUnique({
          where: {
            userId_tournamentId: {
              userId,
              tournamentId: tournament.id,
            },
          },
        });
        joined = !!existing;
      } catch {
        // ignore invalid token
      }
    }

    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId: tournament.id },
      include: { user: true },
      orderBy: { score: 'desc' },
      take: 20,
    });

    return {
      tournamentId: tournament.id, // ✅ ВАЖНО
      type: tournament.type,
      status: tournament.status,
      startsAt: tournament.startsAt,
      endsAt: tournament.endsAt,
      entryFee: tournament.entryFee,
      prizePool: tournament.prizePool,
      joined, // ✅ ВАЖНО
      participants: participants.map((p) => ({
        userId: p.userId,
        username: p.user.username ?? p.user.firstName ?? null,
        score: p.score,
      })),
    };
  }
}
