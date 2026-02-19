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

  // ───────────────── BOT SETTINGS ─────────────────
  private readonly CASHCUP_FILL_TO = 8;   // сколько участников хотим видеть
  private readonly CASHCUP_MAX_BOTS = 5;  // максимум ботов в одном cash cup
  private readonly BOT_TICK_MAX_ADD = 80; // max прирост за тик
  private readonly BOT_TICK_MIN_ADD = 20; // min прирост за тик

  // имена, которые будут рандомно ставиться ботам (username/firstName)
  private readonly BOT_NAMES = [
    'Aram', 'Mariam', 'Gor', 'Lilit', 'Hayk', 'Nare', 'Karen', 'Sona',
    'Levon', 'Ani', 'Tigran', 'Mane', 'Vardan', 'Eva', 'Artur', 'Mika',
    'Narek', 'David', 'Ashot', 'Lusine', 'Mher', 'Meline', 'Ruben', 'Tatev',
  ];

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

  // ───────────────── STANDARD (HOURLY / DAILY) PRIZES ─────────────────
  private calculateStandardPrizes(prizePool: number, count: number): number[] {
    if (count < 2) return [];

    return [
      Math.floor(prizePool * 0.4), // 🥇 40%
      Math.floor(prizePool * 0.2), // 🥈 20%
      Math.floor(prizePool * 0.1), // 🥉 10%
    ];
  }

  // ───────────────── BOT HELPERS ─────────────────
  private pickBotName(seed?: number) {
    // простой псевдорандом (чтобы не было одинаковых подряд)
    const idx = Math.floor(Math.random() * this.BOT_NAMES.length);
    const base = this.BOT_NAMES[idx];
    // иногда добавим цифру
    const suffix = Math.random() < 0.25 ? `_${Math.floor(Math.random() * 99)}` : '';
    return `${base}${suffix}`;
  }

  private async rotateBotNamesForTournament(tournamentId: number) {
    // Меняем username/firstName только у ботов, которые участвуют в турнире.
    // telegramId не трогаем (он уникальный).
    const bots = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId, user: { isBot: true } },
      include: { user: true },
    });

    if (!bots.length) return;

    const tx: Prisma.PrismaPromise<any>[] = [];
    const used = new Set<string>();

    for (const p of bots) {
      let name = this.pickBotName();
      // гарантируем уникальность в рамках турнира
      let guard = 0;
      while (used.has(name) && guard < 10) {
        name = this.pickBotName();
        guard++;
      }
      used.add(name);

      tx.push(
        this.prisma.user.update({
          where: { id: p.userId },
          data: {
            username: name,
            firstName: name,
          },
        }),
      );
    }

    await this.prisma.$transaction(tx);
  }

  private async ensureCashCupBots(tournamentId: number) {
    // Берём текущих участников
    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId },
      include: { user: true },
    });

    const humans = participants.filter((p) => !p.user?.isBot);
    const bots = participants.filter((p) => p.user?.isBot);

    // если людей много — боты не нужны
    if (humans.length >= this.CASHCUP_FILL_TO) return;

    const needTotal = this.CASHCUP_FILL_TO;
    const needBots = Math.min(
      this.CASHCUP_MAX_BOTS - bots.length,
      needTotal - (humans.length + bots.length),
    );

    if (needBots <= 0) return;

    // берём свободных ботов, которых нет в этом турнире
    const botUsers = await this.prisma.user.findMany({
      where: {
        isBot: true,
        tournaments: { none: { tournamentId } },
      },
      take: needBots,
      orderBy: { id: 'asc' },
    });

    if (!botUsers.length) return;

    await this.prisma.tournamentParticipant.createMany({
      data: botUsers.map((u) => ({
        userId: u.id,
        tournamentId,
        payWith: 'coins',
        score: 0,
      })),
      skipDuplicates: true,
    });

    // После добавления — сразу “переименуем”, чтобы каждый cash cup выглядел свежим
    await this.rotateBotNamesForTournament(tournamentId);

    this.logger.log(
      `[BOTS] Added=${botUsers.length} to CASH_CUP tournamentId=${tournamentId}`,
    );
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
      endsAt = new Date(startsAt);
      endsAt.setHours(endsAt.getHours() + 1);
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

  async join(
    token: string,
    type: TournamentType,
    payWith?: 'coins' | 'tickets',
  ) {
    const userId = this.getUserIdFromToken(token);

    this.logger.log(
      `[JOIN] request userId=${userId} type=${type} payWith=${payWith}`,
    );

    if (type === 'CASH_CUP' && !payWith) {
      this.logger.warn(
        `[JOIN][ERROR] CASH_CUP without payWith userId=${userId}`,
      );
      throw new BadRequestException(
        'payWith is required for CASH_CUP (coins|tickets)',
      );
    }

    const method: 'coins' | 'tickets' = payWith ?? 'coins';

    if (method !== 'coins' && method !== 'tickets') {
      this.logger.warn(
        `[JOIN][ERROR] invalid payWith=${payWith} userId=${userId}`,
      );
      throw new BadRequestException('payWith must be coins or tickets');
    }

    this.logger.log(`[JOIN] normalized method=${method} userId=${userId}`);

    const tournament = await this.getOrCreateTournament(type);

    this.logger.log(
      `[JOIN] tournament id=${tournament.id} type=${tournament.type} status=${tournament.status}`,
    );

    if (tournament.status === 'FINISHED') {
      this.logger.warn(`[JOIN][ERROR] tournament finished id=${tournament.id}`);
      throw new BadRequestException('Tournament finished');
    }

    try {
      if (tournament.type === 'CASH_CUP') {
        const REQUIRED = 10;

        const res = await this.prisma.$transaction(async (tx) => {
          const exists = await tx.tournamentParticipant.findUnique({
            where: {
              userId_tournamentId: { userId, tournamentId: tournament.id },
            },
          });

          if (exists) {
            this.logger.log(
              `[JOIN] already joined CASH_CUP userId=${userId} tournamentId=${tournament.id}`,
            );
            return { joined: false, tournamentId: tournament.id };
          }

          if (method === 'tickets') {
            const tickets = await tx.ticket.findMany({
              where: { userId, usedAt: null },
              orderBy: { createdAt: 'asc' },
              take: REQUIRED,
            });

            this.logger.log(
              `[JOIN][CASH_CUP] tickets found=${tickets.length} userId=${userId}`,
            );

            if (tickets.length < REQUIRED) {
              this.logger.warn(
                `[JOIN][CASH_CUP][ERROR] not enough tickets userId=${userId}`,
              );
              throw new BadRequestException('Need 10 tickets');
            }

            for (const t of tickets) {
              await tx.ticket.update({
                where: { id: t.id },
                data: { usedAt: new Date() },
              });
            }

            await tx.tournament.update({
              where: { id: tournament.id },
              data: { prizePool: { increment: REQUIRED } },
            });

            await tx.tournamentParticipant.create({
              data: { userId, tournamentId: tournament.id, payWith: method },
            });

            this.logger.log(
              `[JOIN][CASH_CUP] SUCCESS via=tickets userId=${userId}`,
            );

            return {
              joined: true,
              tournamentId: tournament.id,
              via: 'tickets',
            };
          }

          // coins
          const u = await tx.user.findUnique({
            where: { id: userId },
            select: { coins: true },
          });

          this.logger.log(
            `[JOIN][CASH_CUP] coins balance=${u?.coins} userId=${userId}`,
          );

          if (!u || u.coins < REQUIRED) {
            this.logger.warn(
              `[JOIN][CASH_CUP][ERROR] not enough coins userId=${userId}`,
            );
            throw new BadRequestException('Need 10 coins');
          }

          await tx.user.update({
            where: { id: userId },
            data: { coins: { decrement: REQUIRED } },
          });

          await tx.tournament.update({
            where: { id: tournament.id },
            data: { prizePool: { increment: REQUIRED } },
          });

          await tx.tournamentParticipant.create({
            data: { userId, tournamentId: tournament.id, payWith: method },
          });

          this.logger.log(
            `[JOIN][CASH_CUP] SUCCESS via=coins userId=${userId}`,
          );

          return { joined: true, tournamentId: tournament.id, via: 'coins' };
        });

        // ✅ после join — заполним ботами (без транзакции, отдельно)
        try {
          await this.ensureCashCupBots(tournament.id);
        } catch (e) {
          this.logger.warn(`[BOTS] ensureCashCupBots failed: ${String(e)}`);
        }

        return res;
      }

      // ─────────────── HOURLY / DAILY ───────────────
      const REQUIRED = tournament.type === 'HOURLY' ? 50 : 100;

      return await this.prisma.$transaction(async (tx) => {
        const exists = await tx.tournamentParticipant.findUnique({
          where: {
            userId_tournamentId: { userId, tournamentId: tournament.id },
          },
        });

        if (exists) {
          this.logger.log(
            `[JOIN] already joined ${tournament.type} userId=${userId}`,
          );
          return { joined: false, tournamentId: tournament.id };
        }

        if (method === 'tickets') {
          const tickets = await tx.ticket.findMany({
            where: { userId, usedAt: null },
            orderBy: { createdAt: 'asc' },
            take: REQUIRED,
          });

          this.logger.log(
            `[JOIN][${tournament.type}] tickets found=${tickets.length} userId=${userId}`,
          );

          if (tickets.length < REQUIRED) {
            throw new BadRequestException(`Need ${REQUIRED} tickets`);
          }

          for (const t of tickets) {
            await tx.ticket.update({
              where: { id: t.id },
              data: { usedAt: new Date() },
            });
          }

          await tx.tournament.update({
            where: { id: tournament.id },
            data: { prizePool: { increment: REQUIRED } },
          });

          await tx.tournamentParticipant.create({
            data: { userId, tournamentId: tournament.id, payWith: method },
          });

          this.logger.log(
            `[JOIN][${tournament.type}] SUCCESS via=tickets userId=${userId}`,
          );

          return { joined: true, tournamentId: tournament.id, via: 'tickets' };
        }

        const u = await tx.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });

        this.logger.log(
          `[JOIN][${tournament.type}] coins balance=${u?.coins} userId=${userId}`,
        );

        if (!u || u.coins < REQUIRED) {
          throw new BadRequestException(`Need ${REQUIRED} coins`);
        }

        await tx.user.update({
          where: { id: userId },
          data: { coins: { decrement: REQUIRED } },
        });

        await tx.tournament.update({
          where: { id: tournament.id },
          data: { prizePool: { increment: REQUIRED } },
        });

        await tx.tournamentParticipant.create({
          data: { userId, tournamentId: tournament.id, payWith: method },
        });

        this.logger.log(
          `[JOIN][${tournament.type}] SUCCESS via=coins userId=${userId}`,
        );

        return { joined: true, tournamentId: tournament.id, via: 'coins' };
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        this.logger.warn(
          `[JOIN][RACE] participant already exists userId=${userId}`,
        );
        return { joined: false, tournamentId: tournament.id };
      }

      this.logger.error(
        `[JOIN][FATAL] userId=${userId} error=${e?.message ?? e}`,
      );
      throw e;
    }
  }

  // ───────────────── SUBMIT SCORE ─────────────────
  async submitScore(token: string, tournamentId: number, score: number) {
    const userId = this.getUserIdFromToken(token);

    // ✅ анти-мусор
    score = Math.floor(score);
    if (!Number.isFinite(score) || score < 0) return { updated: false };

    // (опционально) быстрый античит лимит
    // подстрой под свою игру
    score = Math.min(score, 50000);

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

  // ───────────────── BOT TICKER ─────────────────
  // делает турнир "живым": боты набирают очки, но не душат людей
  @Cron(CronExpression.EVERY_10_SECONDS)
  async tickCashCupBots() {
    const now = new Date();

    const cups = await this.prisma.tournament.findMany({
      where: {
        status: 'ACTIVE',
        type: 'CASH_CUP',
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      include: {
        participants: { include: { user: true } },
      },
    });

    for (const t of cups) {
      const bots = t.participants.filter((p) => p.user?.isBot);
      if (!bots.length) continue;

      const humans = t.participants.filter((p) => !p.user?.isBot);

      const humanScores = humans.map((h) => h.score);
      const humanMax = humanScores.length ? Math.max(...humanScores) : 0;
      const humanAvg = humanScores.length
        ? Math.floor(humanScores.reduce((a, b) => a + b, 0) / humanScores.length)
        : 250;

      // мягкий потолок: боты держатся около среднего и чуть ниже лидера
      const softCap = Math.max(humanAvg + 120, humanMax - 80);

      const tx: Prisma.PrismaPromise<any>[] = [];

      for (const b of bots) {
        let add =
          this.BOT_TICK_MIN_ADD +
          Math.floor(Math.random() * (this.BOT_TICK_MAX_ADD - this.BOT_TICK_MIN_ADD + 1));

        // если уже дошёл до softCap — тормозим
        if (b.score >= softCap) add = Math.floor(Math.random() * 10);

        // запрет сильно обгонять людей
        if (b.score + add > humanMax + 20) {
          add = Math.max(0, (humanMax + 20) - b.score);
        }

        if (add <= 0) continue;

        tx.push(
          this.prisma.tournamentParticipant.update({
            where: { id: b.id },
            data: { score: { increment: add } },
          }),
        );
      }

      if (tx.length) {
        await this.prisma.$transaction(tx);
      }
    }
  }

  // ───────────────── FINISH ─────────────────
  @Cron(CronExpression.EVERY_MINUTE)
  async finishExpiredTournaments() {
    const tournaments = await this.prisma.tournament.findMany({
      where: { status: 'ACTIVE', endsAt: { lte: new Date() } },
      include: {
        participants: {
          include: { user: true },
        },
      },
    });

    for (const t of tournaments) {
      const sorted = [...t.participants].sort((a, b) => b.score - a.score);

      // ✅ люди отдельно (боты не получают призы)
      const humans = sorted.filter((p) => !p.user?.isBot);

      // ───────────── 1 HUMAN → REFUND ─────────────
      if (humans.length === 1) {
        const p = humans[0];
        const payWith = (p as any).payWith as 'coins' | 'tickets' | undefined;

        const fee = t.entryFee;

        if (payWith === 'tickets') {
          await this.prisma.ticket.createMany({
            data: Array.from({ length: fee }, () => ({
              userId: p.userId,
              type: 'TOURNAMENT',
            })),
          });
        } else {
          await this.prisma.user.update({
            where: { id: p.userId },
            data: { coins: { increment: fee } },
          });
        }

        await this.prisma.tournament.update({
          where: { id: t.id },
          data: { status: 'FINISHED' },
        });

        if (p.user?.telegramId) {
          await this.safeSendTelegramMessage(
            String(p.user.telegramId),
            `ℹ️ В турнире ${this.formatTournamentTitle(t.type as any)} не было соперников.\nВзнос возвращён (${payWith === 'tickets' ? `🎟 ${fee} tickets` : `🪙 ${fee} coins`}).`,
          );
        }

        continue;
      }

      // призы
      let prizes: number[] = [];

      if (t.type === 'CASH_CUP') {
        prizes = this.calculateCashCupPrizes(t.prizePool, humans.length);
      } else {
        prizes = this.calculateStandardPrizes(t.prizePool, humans.length);
      }

      const winners = humans.slice(0, prizes.length);

      const tx: Prisma.PrismaPromise<any>[] = [];

      winners.forEach((p, i) => {
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

      // ✅ уведомить топ-3 людей
      const top = winners.slice(0, Math.min(3, prizes.length));
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

    // ✅ при заходе в CASH_CUP добиваем ботами
    if (tournament.type === 'CASH_CUP' && tournament.status === 'ACTIVE') {
      try {
        await this.ensureCashCupBots(tournament.id);
      } catch (e) {
        this.logger.warn(`[BOTS] ensureCashCupBots failed: ${String(e)}`);
      }
    }

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
