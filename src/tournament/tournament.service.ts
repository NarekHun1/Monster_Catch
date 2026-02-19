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
  // ✅ ровно 3 бота, но только если есть хотя бы 1 человек
  private readonly CASHCUP_BOTS_ALWAYS = 3;
  private readonly CASHCUP_MAX_BOTS = 7;

  // пул ботов в базе
  private readonly BOT_POOL_MIN = 30;

  // CASH_CUP fee (как в join)
  private readonly CASHCUP_REQUIRED = 10;

  // ✅ one-jump окно
  private readonly BOT_JUMP_WINDOW_FROM = 0.3;
  private readonly BOT_JUMP_WINDOW_TO = 0.8;

  private readonly BOT_BEHIND_MARGIN_MIN = 12;
  private readonly BOT_BEHIND_MARGIN_MAX = 85;

  private readonly BOT_RARE_SPIKE_CHANCE = 0.02;

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

  // ───────────────── DB SAFE MODE ─────────────────
  private dbDownUntil = 0;
  private lastDbErrLogAt = 0;

  // anti-overlap
  private cashCupTickRunning = false;
  private finishTickRunning = false;

  private isDbDown(): boolean {
    return Date.now() < this.dbDownUntil;
  }

  private isPrismaDbError(e: any): boolean {
    const msg = String(e?.message || e);
    return (
      e?.code === 'P1000' ||
      e?.code === 'P1001' ||
      e?.code === 'P1002' ||
      e?.code === 'P1017' || // ✅ Server has closed the connection
      msg.includes("Can't reach database server") ||
      msg.includes('Server has closed the connection') ||
      msg.includes('Connection terminated') ||
      msg.includes('ECONNRESET') ||
      msg.includes('socket hang up')
    );
  }

  private markDbDown(e: unknown) {
    const now = Date.now();
    const prevLeft = Math.max(0, this.dbDownUntil - now);

    // exponential backoff: 10s → 20s → 40s → 60s (max)
    const next = Math.min(
      60_000,
      Math.max(10_000, prevLeft ? prevLeft * 2 : 10_000),
    );

    this.dbDownUntil = now + next;

    // лог не чаще 1 раза в 15 секунд
    if (now - this.lastDbErrLogAt > 15_000) {
      this.lastDbErrLogAt = now;
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `[DB] unreachable. Pausing DB ops for ${Math.round(next / 1000)}s → ${msg}`,
      );
    }
  }

  private async reconnectPrisma() {
    try {
      await this.prisma.$disconnect();
    } catch {}
    try {
      await this.prisma.$connect();
    } catch {}
  }

  private async dbGuard<T>(fn: () => Promise<T>): Promise<T> {
    if (this.isDbDown()) {
      throw new BadRequestException('DB temporarily unavailable');
    }
    try {
      return await fn();
    } catch (e: any) {
      if (this.isPrismaDbError(e)) {
        this.markDbDown(e);
        await this.reconnectPrisma();
      }
      throw e;
    }
  }

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

  // ✅ детерминированное 0..1
  private hash01(seed: string): number {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 1_000_000) / 1_000_000;
  }

  /**
   * ✅ Гарантирует пул ботов в базе (user.isBot=true).
   */
  private async ensureBotPool() {
    await this.dbGuard(async () => {
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
    });
  }

  /**
   * ✅ Переименовывает ботов внутри конкретного турнира (чтобы не палились повтором имён).
   */
  private async rotateBotNamesForTournament(tournamentId: number) {
    await this.dbGuard(async () => {
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
    });
  }

  /**
   * ✅ Добавляет РОВНО 3 бота ТОЛЬКО если уже есть хотя бы 1 человек.
   * ✅ prizePool увеличивается (боты “вносят” как люди).
   */
  private async ensureCashCupBotsIfHumans(tournamentId: number) {
    await this.ensureBotPool();

    await this.dbGuard(async () => {
      const participants = await this.prisma.tournamentParticipant.findMany({
        where: { tournamentId },
        include: { user: true },
      });

      const humans = participants.filter((p) => !p.user?.isBot);
      if (humans.length === 0) return;

      const botsInCup = participants.filter((p) => p.user?.isBot).length;
      const targetBots = Math.min(this.CASHCUP_BOTS_ALWAYS, this.CASHCUP_MAX_BOTS);
      const needBots = targetBots - botsInCup;
      if (needBots <= 0) return;

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

      const inc = botUsers.length * this.CASHCUP_REQUIRED;

      await this.prisma.$transaction([
        this.prisma.tournamentParticipant.createMany({
          data: botUsers.map((u) => ({
            userId: u.id,
            tournamentId,
            payWith: 'coins',
            score: 0,
          })),
          skipDuplicates: true,
        }),
        this.prisma.tournament.update({
          where: { id: tournamentId },
          data: { prizePool: { increment: inc } },
        }),
      ]);

      await this.rotateBotNamesForTournament(tournamentId);

      this.logger.log(
        `[BOTS] Added=${botUsers.length} bots; prizePool += ${inc}; tournamentId=${tournamentId}`,
      );
    });
  }

  // ───────────────── CREATE / GET ─────────────────
  async getOrCreateTournament(type: TournamentType) {
    return this.dbGuard(async () => {
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

      return tournament;
    });
  }

  // ───────────────── JOIN ─────────────────
  async join(token: string, type: TournamentType, payWith?: 'coins' | 'tickets') {
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
        const REQUIRED = this.CASHCUP_REQUIRED;

        const res = await this.dbGuard(() =>
          this.prisma.$transaction(async (tx) => {
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

              return { joined: true, tournamentId: tournament.id, via: 'tickets' as const };
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

            return { joined: true, tournamentId: tournament.id, via: 'coins' as const };
          }),
        );

        // ✅ после join — добавляем 3 бота (теперь точно есть человек)
        try {
          await this.ensureCashCupBotsIfHumans(tournament.id);
        } catch (e) {
          this.logger.warn(`[BOTS] ensureCashCupBotsIfHumans failed: ${String(e)}`);
        }

        return res;
      }

      // ─────────────── HOURLY / DAILY ───────────────
      const REQUIRED = tournament.type === 'HOURLY' ? 50 : 100;

      return await this.dbGuard(() =>
        this.prisma.$transaction(async (tx) => {
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

            return { joined: true, tournamentId: tournament.id, via: 'tickets' as const };
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

          return { joined: true, tournamentId: tournament.id, via: 'coins' as const };
        }),
      );
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

    const tournament = await this.dbGuard(() =>
      this.prisma.tournament.findUnique({ where: { id: tournamentId } }),
    );

    if (!tournament || tournament.status !== 'ACTIVE' || new Date() > tournament.endsAt) {
      return { updated: false };
    }

    const p = await this.dbGuard(() =>
      this.prisma.tournamentParticipant.findUnique({
        where: { userId_tournamentId: { userId, tournamentId } },
      }),
    );

    if (!p || p.score !== 0) return { updated: false };

    await this.dbGuard(() =>
      this.prisma.tournamentParticipant.update({
        where: { id: p.id },
        data: { score },
      }),
    );

    return { updated: true };
  }

  // ───────────────── BOT “ONE JUMP” TICKER ─────────────────
  @Cron(CronExpression.EVERY_10_SECONDS)
  async tickCashCupBots() {
    if (this.cashCupTickRunning) return;
    this.cashCupTickRunning = true;

    try {
      if (this.isDbDown()) return;

      const now = new Date();

      // легче: без include participants
      const cups = await this.dbGuard(() =>
        this.prisma.tournament.findMany({
          where: {
            status: 'ACTIVE',
            type: 'CASH_CUP',
            startsAt: { lte: now },
            endsAt: { gt: now },
          },
          select: { id: true, startsAt: true, endsAt: true },
        }),
      );

      for (const t of cups) {
        const participants = await this.dbGuard(() =>
          this.prisma.tournamentParticipant.findMany({
            where: { tournamentId: t.id },
            include: { user: true },
          }),
        );

        const humans = participants.filter((p) => !p.user?.isBot);
        if (humans.length === 0) continue;

        const humanScores = humans.map((h) => h.score);
        const humanMax = humanScores.length ? Math.max(...humanScores) : 0;

        // пока люди не начали играть — боты стоят 0
        if (humanMax <= 0) continue;

        const humanAvg = humanScores.length
          ? Math.floor(humanScores.reduce((a, b) => a + b, 0) / humanScores.length)
          : humanMax;

        const bots = participants.filter((p) => p.user?.isBot);
        if (!bots.length) continue;

        const totalMs = Math.max(1, t.endsAt.getTime() - t.startsAt.getTime());
        const elapsedMs = Math.max(0, now.getTime() - t.startsAt.getTime());
        const progress = Math.min(1, elapsedMs / totalMs);

        const tx: Prisma.PrismaPromise<any>[] = [];

        for (const b of bots) {
          // бот уже "сыграл"
          if (b.score > 0) continue;

          // детерминированное время jump (30%..80%)
          const r = this.hash01(`cup:${t.id}:bot:${b.userId}`);
          const jumpAt =
            this.BOT_JUMP_WINDOW_FROM +
            (this.BOT_JUMP_WINDOW_TO - this.BOT_JUMP_WINDOW_FROM) * r;

          if (progress < jumpAt) continue;

          const behind =
            this.BOT_BEHIND_MARGIN_MIN +
            Math.floor(
              Math.random() *
              (this.BOT_BEHIND_MARGIN_MAX - this.BOT_BEHIND_MARGIN_MIN + 1),
            );

          let target = humanAvg + Math.floor(Math.random() * 120) - 60;

          // cap: строго ниже top человека
          const cap = Math.max(0, Math.min(humanMax - 1, humanMax - behind));
          if (target > cap) target = cap;

          // редкий “почти догнал”, но всё равно ниже humanMax
          if (Math.random() < this.BOT_RARE_SPIKE_CHANCE) {
            target = Math.max(0, humanMax - (2 + Math.floor(Math.random() * 8)));
            if (target >= humanMax) target = humanMax - 1;
          }

          if (target <= 0) target = 25 + Math.floor(Math.random() * 80);

          tx.push(
            this.prisma.tournamentParticipant.update({
              where: { id: b.id },
              data: { score: target },
            }),
          );
        }

        if (tx.length) {
          await this.dbGuard(() => this.prisma.$transaction(tx));
        }
      }
    } catch (e: any) {
      if (this.isPrismaDbError(e)) {
        this.markDbDown(e);
        return;
      }
      this.logger.error(`[tickCashCupBots] ${e?.message ?? String(e)}`, e?.stack);
    } finally {
      this.cashCupTickRunning = false;
    }
  }

  // ───────────────── FINISH ─────────────────
  @Cron(CronExpression.EVERY_MINUTE)
  async finishExpiredTournaments() {
    if (this.finishTickRunning) return 0;
    this.finishTickRunning = true;

    try {
      if (this.isDbDown()) return 0;

      const tournaments = await this.dbGuard(() =>
        this.prisma.tournament.findMany({
          where: { status: 'ACTIVE', endsAt: { lte: new Date() } },
          include: { participants: { include: { user: true } } },
        }),
      );

      for (const t of tournaments) {
        const sorted = [...t.participants].sort((a, b) => b.score - a.score);
        const humans = sorted.filter((p) => !p.user?.isBot);

        // ✅ если людей нет — просто закрываем
        if (humans.length === 0) {
          await this.dbGuard(() =>
            this.prisma.tournament.update({
              where: { id: t.id },
              data: { status: 'FINISHED' },
            }),
          );
          continue;
        }

        // 1 человек → refund
        if (humans.length === 1) {
          const p = humans[0];
          const payWith = (p as any).payWith as 'coins' | 'tickets' | undefined;
          const fee = t.entryFee;

          await this.dbGuard(async () => {
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
          });

          if (p.user?.telegramId) {
            await this.safeSendTelegramMessage(
              String(p.user.telegramId),
              `ℹ️ В турнире ${this.formatTournamentTitle(
                t.type as any,
              )} не было соперников.\nВзнос возвращён (${
                payWith === 'tickets' ? `🎟 ${fee} tickets` : `🪙 ${fee} coins`
              }).`,
            );
          }

          continue;
        }

        const prizes =
          t.type === 'CASH_CUP'
            ? this.calculateCashCupPrizes(t.prizePool, humans.length)
            : this.calculateStandardPrizes(t.prizePool, humans.length);

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

        await this.dbGuard(() => this.prisma.$transaction(tx));

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
    } catch (e: any) {
      if (this.isPrismaDbError(e)) {
        this.markDbDown(e);
        return 0;
      }
      this.logger.error(`[finishExpiredTournaments] ${e?.message ?? String(e)}`, e?.stack);
      return 0;
    } finally {
      this.finishTickRunning = false;
    }
  }

  // ───────────────── CURRENT ─────────────────
  async getCurrentTournament(type: TournamentType, token?: string) {
    const tournament = await this.getOrCreateTournament(type);

    // ⚠️ НЕ вызываем ensureCashCupBotsIfHumans здесь — иначе фронт DDOSит БД.
    // Боты добавляются только после join.

    let joined = false;
    let coins = 0;
    let ticketsCount = 0;

    if (token) {
      try {
        const uid = this.getUserIdFromToken(token); // ✅ number (не null)

        joined = !!(await this.dbGuard(() =>
          this.prisma.tournamentParticipant.findUnique({
            where: {
              userId_tournamentId: {
                userId: uid, // ✅ fixed TS2322
                tournamentId: tournament.id,
              },
            },
          }),
        ));

        const user = await this.dbGuard(() =>
          this.prisma.user.findUnique({
            where: { id: uid },
            select: { coins: true },
          }),
        );

        coins = user?.coins ?? 0;

        ticketsCount = await this.dbGuard(() =>
          this.prisma.ticket.count({
            where: { userId: uid, usedAt: null },
          }),
        );
      } catch {
        // ignore token/db errors for status endpoint
      }
    }

    const participants = await this.dbGuard(() =>
      this.prisma.tournamentParticipant.findMany({
        where: { tournamentId: tournament.id },
        include: { user: true },
        orderBy: { score: 'desc' },
        take: 20,
      }),
    );

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
