import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

interface JwtPayload {
  userId: number;
}

@Injectable()
export class TournamentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
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

    const entryFee = 1; // 1 монетка

    if (!tournament) {
      // создаём новый
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
      // можно при желании обновить статус
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

    // Проверяем, не участвует ли уже
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

    // Транзакция: списать монетку, создать участника, увеличить prizePool
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
      // новый результат хуже или равен — игнорим
      return { updated: false, score: participant.score };
    }

    const updated = await this.prisma.tournamentParticipant.update({
      where: { id: participant.id },
      data: { score },
    });

    return { updated: true, score: updated.score };
  }

  /** Завершить турнир, раздать призы (можно дергать cron-ом раз в несколько минут) */
  async finishExpiredTournaments() {
    const now = new Date();

    // объявляем нормальный тип
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

      const prize1 = p1 ? Math.floor(pool * 0.4) : 0;
      const prize2 = p2 ? Math.floor(pool * 0.2) : 0;
      const prize3 = p3 ? Math.floor(pool * 0.1) : 0;

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

      results.push({
        id: t.id,
        prizePool: t.prizePool,
        winners: [
          p1 && { userId: p1.userId, prize: prize1, score: p1.score },
          p2 && { userId: p2.userId, prize: prize2, score: p2.score },
          p3 && { userId: p3.userId, prize: prize3, score: p3.score },
        ].filter(Boolean) as { userId: number; prize: number; score: number }[],
      });
    }

    return results;
  }

  /** Турнирная таблица по текущему турниру */
  async getCurrentLeaderboard() {
    // 👉 всегда найдёт ИЛИ создаст турнир на текущий час
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
