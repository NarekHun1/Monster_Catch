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

@Injectable()
export class TournamentService {
  private readonly logger = new Logger(TournamentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectBot() private readonly bot: Telegraf, // 👈 бот для уведомлений
  ) {}

  private getUserIdFromToken(token: string): number {
    if (!token) throw new UnauthorizedException('Token missing');

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret) throw new UnauthorizedException('JWT secret missing');

    try {
      const payload = jwt.verify(token, secret) as JwtPayload;
      if (!payload.userId) {
        throw new UnauthorizedException('Token payload has no userId');
      }
      return payload.userId;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }

  /** Округляем время вниз до часа (начало часа) */
  private floorToHour(date: Date): Date {
    const d = new Date(date);
    d.setMinutes(0, 0, 0);
    return d;
  }

  /** Берём текущий или создаём новый турнир для этого часа */
  async getOrCreateCurrentTournament(): Promise<
    import('@prisma/client').Tournament
  > {
    const now = new Date();
    const hourStart = this.floorToHour(now);

    const joinsCloseAt = new Date(hourStart);
    joinsCloseAt.setMinutes(10, 0, 0); // окно вступления 10 минут

    const endsAt = new Date(hourStart);
    endsAt.setMinutes(20, 0, 0); // длительность турнира 20 минут

    // Ищем турнир этого часа
    let tournament = await this.prisma.tournament.findFirst({
      where: {
        startsAt: hourStart,
      },
    });

    const entryFee = 50; // 50 монетка

    if (!tournament) {
      tournament = await this.prisma.tournament.create({
        data: {
          startsAt: hourStart,
          joinDeadline: joinsCloseAt,
          endsAt,
          entryFee,
          status:
            now >= endsAt
              ? 'FINISHED'
              : now >= hourStart
                ? 'ACTIVE'
                : 'PLANNED',
        },
      });
    } else {
      const status =
        now >= tournament.endsAt
          ? 'FINISHED'
          : now >= tournament.startsAt
            ? 'ACTIVE'
            : 'PLANNED';

      if (status !== tournament.status) {
        tournament = await this.prisma.tournament.update({
          where: { id: tournament.id },
          data: { status },
        });
      }
    }

    return tournament;
  }

  /** Получить текущий турнир (без создания) */
  async getCurrentTournament() {
    const now = new Date();
    const hourStart = this.floorToHour(now);

    const t = await this.prisma.tournament.findFirst({
      where: {
        startsAt: hourStart,
      },
      include: {
        participants: true,
      },
    });

    return t;
  }

  /** Вступить в турнир: списываем 1 монетку, добавляем участника, увеличиваем prizePool */
  async join(token: string) {
    const userId = this.getUserIdFromToken(token);
    const now = new Date();

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    const tournament = await this.getOrCreateCurrentTournament();

    if (tournament.status === 'FINISHED' || now > tournament.joinDeadline) {
      throw new BadRequestException('Join window is closed');
    }

    if (user.coins < tournament.entryFee) {
      throw new BadRequestException('Not enough coins to join tournament');
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
      return {
        joined: false,
        reason: 'ALREADY_JOINED',
        tournamentId: tournament.id,
      };
    }

    const [updatedUser, updatedTournament, participant] =
      await this.prisma.$transaction([
        this.prisma.user.update({
          where: { id: userId },
          data: {
            coins: { decrement: tournament.entryFee },
          },
        }),
        this.prisma.tournament.update({
          where: { id: tournament.id },
          data: {
            prizePool: { increment: tournament.entryFee },
            status: 'ACTIVE',
          },
        }),
        this.prisma.tournamentParticipant.create({
          data: {
            userId,
            tournamentId: tournament.id,
          },
        }),
      ]);

    return {
      joined: true,
      tournament: updatedTournament,
      coins: updatedUser.coins,
      participantId: participant.id,
    };
  }

  /** Обновить лучший счёт участника в турнире */
  async submitScore(token: string, tournamentId: number, score: number) {
    const userId = this.getUserIdFromToken(token);
    const now = new Date();

    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });

    if (!tournament) {
      throw new BadRequestException('Tournament not found');
    }

    if (now > tournament.endsAt) {
      throw new BadRequestException('Tournament already finished');
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
      throw new BadRequestException('You are not in this tournament');
    }

    if (score <= participant.score) {
      return { updated: false, score: participant.score };
    }

    const updated = await this.prisma.tournamentParticipant.update({
      where: { id: participant.id },
      data: { score },
    });

    return { updated: true, score: updated.score };
  }

  /** КРОН: вызывается, чтобы завершать турниры */
  @Cron(CronExpression.EVERY_MINUTE) // можно сделать раз в 2 мин, если хочешь
  async handleFinishCron() {
    const res = await this.finishExpiredTournaments();
    if (res.length > 0) {
      this.logger.log(`Finished ${res.length} tournaments`);
    }
  }

  /** Завершить турнир, раздать призы + уведомить победителей */
  async finishExpiredTournaments() {
    const now = new Date();

    const results: {
      id: number;
      prizePool: number;
      winners: { userId: number; prize: number; score: number }[];
    }[] = [];

    const tournaments = await this.prisma.tournament.findMany({
      where: {
        status: { in: ['PLANNED', 'ACTIVE'] },
        endsAt: { lte: now },
      },
      include: {
        participants: {
          include: { user: true },
        },
      },
    });

    for (const t of tournaments) {
      if (t.participants.length === 0) {
        await this.prisma.tournament.update({
          where: { id: t.id },
          data: { status: 'FINISHED' },
        });

        results.push({
          id: t.id,
          prizePool: t.prizePool,
          winners: [],
        });

        continue;
      }

      const sorted = [...t.participants].sort((a, b) => b.score - a.score);
      const [p1, p2, p3] = sorted;

      const pool = t.prizePool;
      const count = sorted.length;
      const fee = t.entryFee;

      let prize1 = 0;
      let prize2 = 0;
      let prize3 = 0;

      if (count === 1 && p1) {
        prize1 = Math.min(fee, pool);
      } else if (count === 2 && p1) {
        prize1 = Math.min(2 * fee, pool);
      } else if (count >= 3 && count <= 4) {
        if (p1) {
          prize1 = Math.min(2 * fee, pool);
        }
        if (p2 && pool - prize1 >= fee) {
          prize2 = fee;
        }
      } else if (count >= 5) {
        if (p1) {
          prize1 = Math.floor(pool * 0.4);
        }
        let remaining = pool - prize1;

        if (p2 && remaining >= fee) {
          prize2 = fee;
          remaining -= fee;
        }
        if (p3 && remaining >= fee) {
          prize3 = fee;
          remaining -= fee;
        }
      }

      const updates: any[] = [];

      if (p1 && prize1 > 0) {
        updates.push(
          this.prisma.user.update({
            where: { id: p1.userId },
            data: { coins: { increment: prize1 } },
          }),
        );
      }
      if (p2 && prize2 > 0) {
        updates.push(
          this.prisma.user.update({
            where: { id: p2.userId },
            data: { coins: { increment: prize2 } },
          }),
        );
      }
      if (p3 && prize3 > 0) {
        updates.push(
          this.prisma.user.update({
            where: { id: p3.userId },
            data: { coins: { increment: prize3 } },
          }),
        );
      }

      await this.prisma.$transaction([
        ...updates,
        this.prisma.tournament.update({
          where: { id: t.id },
          data: { status: 'FINISHED' },
        }),
      ]);

      const winners = [
        p1 && { userId: p1.userId, prize: prize1, score: p1.score },
        p2 && { userId: p2.userId, prize: prize2, score: p2.score },
        p3 && { userId: p3.userId, prize: prize3, score: p3.score },
      ].filter(Boolean) as { userId: number; prize: number; score: number }[];

      results.push({
        id: t.id,
        prizePool: t.prizePool,
        winners,
      });

      // 🔔 УВЕДОМЛЕНИЯ победителям
      for (const w of winners) {
        const user = t.participants.find((p) => p.userId === w.userId)?.user;
        if (!user || !user.telegramId) continue;

        const place =
          w.userId === p1?.userId ? 1 : w.userId === p2?.userId ? 2 : 3;

        const text =
          place === 1
            ? `🏆 Турнир завершён!\n\nТы занял 1 место с результатом ${w.score} очков и получил ${w.prize} монет 🪙`
            : `🥈 Турнир завершён!\n\nТы занял ${place} место с результатом ${w.score} очков и получил ${w.prize} монет 🪙`;

        try {
          await this.bot.telegram.sendMessage(Number(user.telegramId), text);
        } catch (err) {
          this.logger.warn(
            `Не удалось отправить уведомление пользователю ${user.id}`,
          );
        }
      }
    }

    return results;
  }

  /** Турнирная таблица по текущему турниру */
  async getCurrentLeaderboard() {
    const t = await this.getOrCreateCurrentTournament();

    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId: t.id },
      include: { user: true },
      orderBy: { score: 'desc' },
      take: 20,
    });

    return {
      tournamentId: t.id,
      startsAt: t.startsAt,
      endsAt: t.endsAt,
      joinDeadline: t.joinDeadline,
      prizePool: t.prizePool,
      entryFee: t.entryFee,
      status: t.status,
      participants: participants.map((p) => ({
        userId: p.userId,
        username: p.user.username ?? p.user.firstName ?? null,
        score: p.score,
      })),
    };
  }
}
