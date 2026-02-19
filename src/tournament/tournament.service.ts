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

  // ───────────────── CASH CUP BOT SETTINGS ─────────────────
  // ✅ Всегда добавляем ровно 3 бота (если есть место)
  private readonly CASHCUP_BOTS_ALWAYS = 3;

  // лимит ботов на турнир (на всякий)
  private readonly CASHCUP_MAX_BOTS = 7;

  // пул ботов в базе
  private readonly BOT_POOL_MIN = 30;

  // тик-диапазон
  private readonly BOT_TICK_MAX_ADD = 80;
  private readonly BOT_TICK_MIN_ADD = 20;

  // через сколько секунд после появления первого human score>0 боты могут начать тикать
  private readonly BOT_START_DELAY_SEC_MIN = 10;
  private readonly BOT_START_DELAY_SEC_MAX = 35;

  // шанс редкого “рывка” (чтобы один бот иногда почти догнал)
  private readonly BOT_RARE_SPIKE_CHANCE = 0.02;

  // насколько боты обычно отстают от топ-человека
  private readonly BOT_BEHIND_MARGIN_MIN = 12;
  private readonly BOT_BEHIND_MARGIN_MAX = 85;

  private readonly BOT_NAMES = [
    'Aram', 'Mariam', 'Gor', 'Lilit', 'Hayk', 'Nare', 'Karen', 'Sona',
    'Levon', 'Ani', 'Tigran', 'Mane', 'Vardan', 'Eva', 'Artur', 'Mika',
    'Narek', 'David', 'Ashot', 'Lusine', 'Mher', 'Meline', 'Ruben', 'Tatev',
    'Suren', 'Liana', 'Gagik', 'Marine', 'Samvel', 'Hasmik', 'Arsen', 'Elina',
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
    return place === 1 ? '🥇 1 место' : place === 2 ? '🥈 2 место' : '🥉 3 место';
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

  // ───────────────── PRIZES ─────────────────
  private calculateCashCupPrizes(prizePool: number, count: number): number[] {
    if (count === 0) return [];
    if (count === 1) return [prizePool];
    return [
      Math.floor(prizePool * 0.5),
      Math.floor(prizePool * 0.2),
      Math.floor(prizePool * 0.1),
    ];
  }

  private calculateStandardPrizes(prizePool: number, count: number): number[] {
    if (count < 2) return [];
    return [
      Math.floor(prizePool * 0.4),
      Math.floor(prizePool * 0.2),
      Math.floor(prizePool * 0.1),
    ];
  }

  // ───────────────── BOT HELPERS ─────────────────
  private pickBotName() {
    const idx = Math.floor(Math.random() * this.BOT_NAMES.length);
    const base = this.BOT_NAMES[idx];
    const suffix = Math.random() < 0.22 ? `_${Math.floor(Math.random() * 999)}` : '';
    return `${base}${suffix}`;
  }

  private genBotTelegramId() {
    const rnd = Math.random().toString(36).slice(2, 10);
    return `bot:${Date.now()}:${rnd}`;
  }

  /**
   * ✅ Гарантирует пул ботов в базе (user.isBot=true).
   */
  private async ensureBotPool() {
    const botCount = await this.prisma.user.count({ where: { isBot: true } });
    if (botCount >= this.BOT_POOL_MIN) return;

    const need = this.BOT_POOL_MIN - botCount;
    this.logger.warn(`[BOTS] Bot pool low: have=${botCount}, creating=${need}`);

    const data: Prisma.UserCreateManyInput[] = Array.from({ length: need }).map(() => {
      const name = this.pickBotName();
      return {
        telegramId: this.genBotTelegramId(),
        username: name,
        firstName: name,
        isBot: true,
      } as any;
    });

    try {
      await this.prisma.user.createMany({ data, skipDuplicates: true });
    } catch (e) {
      this.logger.warn(`[BOTS] createMany failed: ${String(e)}`);
    }
  }

  /**
   * ✅ Переименовывает ботов внутри конкретного турнира (чтобы не палились повтором имён).
   */
  private async rotateBotNamesForTournament(tournamentId: number) {
    const bots = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId, user: { isBot: true } },
      include: { user: true },
    });

    if (!bots.length) return;

    const tx: Prisma.PrismaPromise<any>[] = [];
    const used = new Set<string>();

    for (const p of bots) {
      let name = this.pickBotName();
      let guard = 0;
      while (used.has(name) && guard < 12) {
        name = this.pickBotName();
        guard++;
      }
      used.add(name);

      tx.push(
        this.prisma.user.update({
          where: { id: p.userId },
          data: { username: name, firstName: name },
        }),
      );
    }

    await this.prisma.$transaction(tx);
  }

  /**
   * ✅ Всегда обеспечивает РОВНО 3 бота в CASH_CUP (если возможно).
   * Никогда не добавляет больше 3, даже если турнир пустой.
   */
  private async ensureCashCupAlways3Bots(tournamentId: number) {
    await this.ensureBotPool();

    // текущие участники
    const participants = await this.prisma.tournamentParticipant.findMany({
      where: { tournamentId },
      include: { user: true },
    });

    const botsInCup = participants.filter((p) => p.user?.isBot).length;
    const targetBots = Math.min(this.CASHCUP_BOTS_ALWAYS, this.CASHCUP_MAX_BOTS);

    const needBots = targetBots - botsInCup;
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

    if (!botUsers.length) {
      this.logger.warn(`[BOTS] No free bots available. Need=${needBots}`);
      return;
    }

    // ✅ добавляем ботов с 0 score и отдельным payWith (чтобы легче фильтровать/отлаживать)
    await this.prisma.tournamentParticipant.createMany({
      data: botUsers.map((u) => ({
        userId: u.id,
        tournamentId,
        payWith: 'coins',
        score: 0,
      })),
      skipDuplicates: true,
    });

    await this.rotateBotNamesForTournament(tournamentId);

    this.logger.log(`[BOTS] Added=${botUsers.length} bots (target=3) to tournamentId=${tournamentId}`);
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
    } else if (tournament.status !== 'ACTIVE') {
      tournament = await this.prisma.tournament.update({
        where: { id: tournament.id },
        data: { status: 'ACTIVE' },
      });
    }

    // ✅ ВАЖНО: если CASH_CUP — держим 3 бота всегда
    if (tournament.type === 'CASH_CUP') {
      try {
        await this.ensureCashCupAlways3Bots(tournament.id);
      } catch (e) {
        this.logger.warn(`[BOTS] ensureCashCupAlways3Bots failed: ${String(e)}`);
      }
    }

    return tournament;
  }

  // ───────────────── JOIN ─────────────────
  async join(
    token: string,
    type: TournamentType,
    payWith?: 'coins' | 'tickets',
  ) {
    const userId = this.getUserIdFromToken(token);

    if (type === 'CASH_CUP' && !payWith) {
      throw new BadRequestException('payWith is required for CASH_CUP (coins|tickets)');
    }

    const method: 'coins' | 'tickets' = payWith ?? 'coins';
    if (method !== 'coins' && method !== 'tickets') {
      throw new BadRequestException('payWith must be coins or tickets');
    }

    const tournament = await this.getOrCreateTournament(type);

    if (tournament.status === 'FINISHED') {
      throw new BadRequestException('Tournament finished');
    }

    try {
      // ───────────────── CASH CUP ─────────────────
      if (tournament.type === 'CASH_CUP') {
        const REQUIRED = 10;

        const res = await this.prisma.$transaction(async (tx) => {
          const exists = await tx.tournamentParticipant.findUnique({
            where: {
              userId_tournamentId: { userId, tournamentId: tournament.id },
            },
          });

          if (exists) return { joined: false, tournamentId: tournament.id };

          if (method === 'tickets') {
            const tickets = await tx.ticket.findMany({
              where: { userId, usedAt: null },
              orderBy: { createdAt: 'asc' },
              take: REQUIRED,
            });

            if (tickets.length < REQUIRED) {
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
              data: { userId, tournamentId: tournament.id, payWith: method, score: 0 },
            });

            return { joined: true, tournamentId: tournament.id, via: 'tickets' };
          }

          // coins
          const u = await tx.user.findUnique({
            where: { id: userId },
            select: { coins: true },
          });

          if (!u || u.coins < REQUIRED) {
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
            data: { userId, tournamentId: tournament.id, payWith: method, score: 0 },
          });

          return { joined: true, tournamentId: tournament.id, via: 'coins' };
        });

        // ✅ после join — гарантируем 3 бота (всегда)
        try {
          await this.ensureCashCupAlways3Bots(tournament.id);
        } catch (e) {
          this.logger.warn(`[BOTS] ensureCashCupAlways3Bots failed: ${String(e)}`);
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

        if (exists) return { joined: false, tournamentId: tournament.id };

        if (method === 'tickets') {
          const tickets = await tx.ticket.findMany({
            where: { userId, usedAt: null },
            orderBy: { createdAt: 'asc' },
            take: REQUIRED,
          });

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
            data: { userId, tournamentId: tournament.id, payWith: method, score: 0 },
          });

          return { joined: true, tournamentId: tournament.id, via: 'tickets' };
        }

        const u = await tx.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });

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
          data: { userId, tournamentId: tournament.id, payWith: method, score: 0 },
        });

        return { joined: true, tournamentId: tournament.id, via: 'coins' };
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        return { joined: false, tournamentId: tournament.id };
      }
      throw e;
    }
  }

  // ───────────────── SUBMIT SCORE ─────────────────
  async submitScore(token: string, tournamentId: number, score: number) {
    const userId = this.getUserIdFromToken(token);

    score = Math.floor(score);
    if (!Number.isFinite(score) || score < 0) return { updated: false };
    score = Math.min(score, 50000);

    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });

    if (!tournament || tournament.status !== 'ACTIVE' || new Date() > tournament.endsAt) {
      return { updated: false };
    }

    const p = await this.prisma.tournamentParticipant.findUnique({
      where: { userId_tournamentId: { userId, tournamentId } },
    });

    // ✅ можно обновлять только если был 0 (как у тебя)
    if (!p || p.score !== 0) return { updated: false };

    await this.prisma.tournamentParticipant.update({
      where: { id: p.id },
      data: { score },
    });

    return { updated: true };
  }

  // ───────────────── BOT TICKER ─────────────────
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
      include: { participants: { include: { user: true } } },
    });

    for (const t of cups) {
      const bots = t.participants.filter((p) => p.user?.isBot);
      if (!bots.length) continue;

      const humans = t.participants.filter((p) => !p.user?.isBot);

      // ✅ если людей нет — боты вообще не двигаются (0 выглядит естественно)
      if (humans.length === 0) continue;

      const humanScores = humans.map((h) => h.score);
      const humanMax = humanScores.length ? Math.max(...humanScores) : 0;

      // ✅ пока люди не начали играть (все 0) — боты стоят (иначе “изначально есть score”)
      if (humanMax <= 0) continue;

      // ✅ как только появился первый human score>0 — даём рандомную задержку перед стартом
      const firstHumanPlayedAt = Math.max(
        ...humans.map((h) => (h.score > 0 ? t.startsAt.getTime() + 1 : 0)),
      );
      // проще: используем время турнира + индивидуальный delay (без БД)
      // фактически задержку считаем от "сейчас" назад через startsAt
      const elapsedSec = Math.floor((now.getTime() - t.startsAt.getTime()) / 1000);

      const tx: Prisma.PrismaPromise<any>[] = [];

      for (const b of bots) {
        // ✅ индивидуальная задержка (каждый бот стартует в своё время)
        const delay =
          this.BOT_START_DELAY_SEC_MIN + (b.userId % (this.BOT_START_DELAY_SEC_MAX - this.BOT_START_DELAY_SEC_MIN + 1));
        if (elapsedSec < delay) continue;

        // ✅ индивидуальный темп (0.78..1.34)
        const pace = 0.78 + ((b.userId % 17) / 17) * 0.56;

        // ✅ пропуски тиков (0..9%) чтобы не шли строем
        const skipChance = (b.userId % 10) / 100;
        if (Math.random() < skipChance) continue;

        // базовый add
        let add =
          this.BOT_TICK_MIN_ADD +
          Math.floor(Math.random() * (this.BOT_TICK_MAX_ADD - this.BOT_TICK_MIN_ADD + 1));

        add = Math.floor(add * pace);
        if (add < 1) add = 1;

        // ✅ бот обычно ниже топ-человека
        const behind =
          this.BOT_BEHIND_MARGIN_MIN +
          Math.floor(Math.random() * (this.BOT_BEHIND_MARGIN_MAX - this.BOT_BEHIND_MARGIN_MIN + 1));

        let cap = humanMax - behind;

        // ✅ редкий “рывок” (интрига), но всё равно почти не обгоняет
        if (Math.random() < this.BOT_RARE_SPIKE_CHANCE) {
          cap = humanMax - (4 + Math.floor(Math.random() * 10)); // почти догнал
          add += 10 + Math.floor(Math.random() * 20);
        }

        if (cap < 0) cap = 0;

        // если уже упёрся — не растём
        if (b.score >= cap) continue;

        // не перелетаем потолок
        if (b.score + add > cap) {
          add = cap - b.score;
        }

        if (add <= 0) continue;

        tx.push(
          this.prisma.tournamentParticipant.update({
            where: { id: b.id },
            data: { score: { increment: add } },
          }),
        );
      }

      if (tx.length) await this.prisma.$transaction(tx);
    }
  }

  // ───────────────── FINISH ─────────────────
  @Cron(CronExpression.EVERY_MINUTE)
  async finishExpiredTournaments() {
    const tournaments = await this.prisma.tournament.findMany({
      where: { status: 'ACTIVE', endsAt: { lte: new Date() } },
      include: { participants: { include: { user: true } } },
    });

    for (const t of tournaments) {
      const sorted = [...t.participants].sort((a, b) => b.score - a.score);

      // ✅ призы только людям
      const humans = sorted.filter((p) => !p.user?.isBot);

      // 1 человек → refund
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

      let prizes: number[] = [];
      if (t.type === 'CASH_CUP') prizes = this.calculateCashCupPrizes(t.prizePool, humans.length);
      else prizes = this.calculateStandardPrizes(t.prizePool, humans.length);

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

    // ✅ держим 3 бота всегда (на всякий случай)
    if (tournament.type === 'CASH_CUP') {
      try {
        await this.ensureCashCupAlways3Bots(tournament.id);
      } catch (e) {
        this.logger.warn(`[BOTS] ensureCashCupAlways3Bots failed: ${String(e)}`);
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
    const joinLeftMs = Math.max(0, tournament.joinDeadline.getTime() - now.getTime());

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
