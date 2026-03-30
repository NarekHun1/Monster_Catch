import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { Prisma } from '@prisma/client';
import { PresenceService } from '../presence/presence.service';

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
    private readonly presenceService: PresenceService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  async inviteOnline(token: string, tournamentId: number) {
    const userId = this.getUserIdFromToken(token);

    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });

    if (!tournament) {
      throw new BadRequestException('Tournament not found');
    }

    if (tournament.status !== 'ACTIVE' || new Date() > tournament.endsAt) {
      throw new BadRequestException('Tournament is not active');
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
      throw new BadRequestException('Join tournament first');
    }

    const existingPending = await this.prisma.tournamentInvite.findFirst({
      where: {
        tournamentId,
        fromUserId: userId,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existingPending) {
      return {
        success: true,
        inviteId: existingPending.id,
        toUserId: existingPending.toUserId,
        expiresAt: existingPending.expiresAt,
      };
    }

    let candidate: { userId: number } | null = null;

    for (let i = 0; i < 3; i++) {
      candidate = await this.presenceService.findOnlineCandidate(
        userId,
        tournamentId,
      );

      if (candidate) break;

      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    if (!candidate) {
      return {
        success: false,
        reason: 'NO_ONLINE_PLAYERS',
      };
    }

    const invite = await this.prisma.tournamentInvite.create({
      data: {
        tournamentId,
        fromUserId: userId,
        toUserId: candidate.userId,
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 30_000),
      },
    });

    return {
      success: true,
      inviteId: invite.id,
      toUserId: invite.toUserId,
      expiresAt: invite.expiresAt,
    };
  }
  async getPendingInvite(token: string) {
    const userId = this.getUserIdFromToken(token);

    const invite = await this.prisma.tournamentInvite.findFirst({
      where: {
        toUserId: userId,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        tournament: {
          select: {
            id: true,
            type: true,
          },
        },
        fromUser: {
          select: {
            username: true,
            firstName: true,
          },
        },
      },
    });

    return {
      invite: invite
        ? {
            id: invite.id,
            tournamentId: invite.tournamentId,
            expiresAt: invite.expiresAt,
            fromUserId: invite.fromUserId,
            toUserId: invite.toUserId,
            tournamentType: invite.tournament?.type ?? null,
            fromUsername:
              invite.fromUser?.username ?? invite.fromUser?.firstName ?? null,
          }
        : null,
    };
  }
  async acceptInvite(
    token: string,
    inviteId: number,
    payWith: 'coins' | 'tickets',
  ) {
    const userId = this.getUserIdFromToken(token);

    return this.prisma.$transaction(async (tx) => {
      const invite = await tx.tournamentInvite.findFirst({
        where: {
          id: inviteId,
          toUserId: userId,
          status: 'PENDING',
          expiresAt: { gt: new Date() },
        },
      });

      if (!invite) {
        throw new BadRequestException('Invite not found or expired');
      }

      const tournament = await tx.tournament.findUnique({
        where: { id: invite.tournamentId },
      });

      if (!tournament) {
        throw new BadRequestException('Tournament not found');
      }

      if (tournament.status !== 'ACTIVE' || new Date() > tournament.endsAt) {
        throw new BadRequestException('Tournament is not active');
      }

      const existingParticipant = await tx.tournamentParticipant.findUnique({
        where: {
          userId_tournamentId: {
            userId,
            tournamentId: invite.tournamentId,
          },
        },
      });

      if (existingParticipant) {
        await tx.tournamentInvite.update({
          where: { id: invite.id },
          data: { status: 'ACCEPTED' },
        });

        return {
          success: true,
          tournamentId: invite.tournamentId,
          alreadyJoined: true,
        };
      }

      const required =
        tournament.type === 'CASH_CUP'
          ? 10
          : tournament.type === 'HOURLY'
            ? 50
            : 100;

      if (payWith === 'tickets') {
        const tickets = await tx.ticket.findMany({
          where: { userId, usedAt: null },
          orderBy: { createdAt: 'asc' },
          take: required,
        });

        if (tickets.length < required) {
          throw new BadRequestException(`Need ${required} tickets`);
        }

        for (const t of tickets) {
          await tx.ticket.update({
            where: { id: t.id },
            data: { usedAt: new Date() },
          });
        }
      } else {
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { coins: true },
        });

        if (!user || user.coins < required) {
          throw new BadRequestException(`Need ${required} coins`);
        }

        await tx.user.update({
          where: { id: userId },
          data: {
            coins: { decrement: required },
          },
        });
      }

      await tx.tournament.update({
        where: { id: tournament.id },
        data: { prizePool: { increment: required } },
      });

      await tx.tournamentParticipant.create({
        data: {
          userId,
          tournamentId: tournament.id,
          payWith,
          replayCount: 0,
          usedAttempts: 0,
        },
      });

      await tx.tournamentInvite.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED' },
      });

      return {
        success: true,
        tournamentId: tournament.id,
        payWith,
        joined: true,
      };
    });
  }

  async declineInvite(token: string, inviteId: number) {
    const userId = this.getUserIdFromToken(token);

    const invite = await this.prisma.tournamentInvite.findUnique({
      where: { id: inviteId },
    });

    if (!invite) {
      throw new NotFoundException('Invite not found');
    }

    if (invite.toUserId !== userId) {
      throw new ForbiddenException('This invite is not for you');
    }

    if (invite.status !== 'PENDING') {
      throw new BadRequestException('Invite already handled');
    }

    await this.prisma.tournamentInvite.update({
      where: { id: inviteId },
      data: {
        status: 'DECLINED',
      },
    });

    return {
      success: true,
    };
  }
  // ───────────────── AUTH ─────────────────
  private getUserIdFromToken(token: string): number {
    if (!token) throw new UnauthorizedException('Token missing');

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret) throw new UnauthorizedException('JWT secret missing');

    // 🔥 ВОТ ЭТО ГЛАВНОЕ
    const cleanToken = token.startsWith('Bearer ')
      ? token.slice(7).trim()
      : token.trim();

    try {
      const payload = jwt.verify(cleanToken, secret) as JwtPayload;
      return payload.userId;
    } catch (e) {
      this.logger.warn(`JWT error: ${String(e)}`);
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

  // ───────────────── REPLAY HELPERS ─────────────────
  private getReplayPrice(replayCount: number): number | null {
    const prices = [10, 15, 20];
    return prices[replayCount] ?? null;
  }

  private getAllowedAttempts(replayCount: number): number {
    return 1 + replayCount;
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
      Math.floor(prizePool * 0.4),
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
      // ───────────────── CASH CUP ─────────────────
      if (tournament.type === 'CASH_CUP') {
        const REQUIRED = 10;

        return await this.prisma.$transaction(async (tx) => {
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
              data: {
                userId,
                tournamentId: tournament.id,
                payWith: method,
                replayCount: 0,
                usedAttempts: 0,
              },
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
            data: {
              userId,
              tournamentId: tournament.id,
              payWith: method,
              replayCount: 0,
              usedAttempts: 0,
            },
          });

          this.logger.log(
            `[JOIN][CASH_CUP] SUCCESS via=coins userId=${userId}`,
          );

          return { joined: true, tournamentId: tournament.id, via: 'coins' };
        });
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
            data: {
              userId,
              tournamentId: tournament.id,
              payWith: method,
              replayCount: 0,
              usedAttempts: 0,
            },
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
          data: {
            userId,
            tournamentId: tournament.id,
            payWith: method,
            replayCount: 0,
            usedAttempts: 0,
          },
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

  // ───────────────── BUY REPLAY ─────────────────
  async buyReplay(token: string, tournamentId: number) {
    const userId = this.getUserIdFromToken(token);

    return this.prisma.$transaction(async (tx) => {
      const tournament = await tx.tournament.findUnique({
        where: { id: tournamentId },
      });

      if (
        !tournament ||
        tournament.status !== 'ACTIVE' ||
        new Date() > tournament.endsAt
      ) {
        throw new BadRequestException('Tournament is not active');
      }

      const participant = await tx.tournamentParticipant.findUnique({
        where: {
          userId_tournamentId: { userId, tournamentId },
        },
      });

      if (!participant) {
        throw new BadRequestException('Join tournament first');
      }

      const replayPrice = this.getReplayPrice(participant.replayCount);

      if (replayPrice === null) {
        throw new BadRequestException('Replay limit reached');
      }

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true },
      });

      if (!user || user.coins < replayPrice) {
        throw new BadRequestException(`Need ${replayPrice} coins`);
      }

      await tx.user.update({
        where: { id: userId },
        data: {
          coins: { decrement: replayPrice },
        },
      });

      await tx.tournamentParticipant.update({
        where: { id: participant.id },
        data: {
          replayCount: { increment: 1 },
        },
      });

      return {
        success: true,
        replayPrice,
        replayCountAfterBuy: participant.replayCount + 1,
        usedAttempts: participant.usedAttempts,
        attemptsLeft:
          this.getAllowedAttempts(participant.replayCount + 1) -
          participant.usedAttempts,
        remainingCoins: user.coins - replayPrice,
      };
    });
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

    return this.prisma.$transaction(async (tx) => {
      const p = await tx.tournamentParticipant.findUnique({
        where: {
          userId_tournamentId: { userId, tournamentId },
        },
      });

      if (!p) {
        return { updated: false };
      }

      const allowedAttempts = this.getAllowedAttempts(p.replayCount);

      if (p.usedAttempts >= allowedAttempts) {
        return {
          updated: false,
          reason: 'NO_ATTEMPTS_LEFT',
          replayCount: p.replayCount,
          usedAttempts: p.usedAttempts,
          attemptsLeft: 0,
          nextReplayPrice: this.getReplayPrice(p.replayCount),
        };
      }

      const improved = score > p.score;
      const nextUsedAttempts = p.usedAttempts + 1;
      const attemptsLeft = Math.max(0, allowedAttempts - nextUsedAttempts);

      await tx.tournamentParticipant.update({
        where: { id: p.id },
        data: {
          usedAttempts: { increment: 1 },
          ...(improved ? { score } : {}),
        },
      });

      return {
        updated: true,
        improved,
        previousScore: p.score,
        newScore: improved ? score : p.score,
        replayCount: p.replayCount,
        usedAttempts: nextUsedAttempts,
        attemptsLeft,
        nextReplayPrice: this.getReplayPrice(p.replayCount),
      };
    });
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

      // ───────────── 1 PLAYER → REFUND (same payWith) ─────────────
      if (sorted.length === 1) {
        const p = sorted[0];
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

      if (t.type === 'CASH_CUP') {
        prizes = this.calculateCashCupPrizes(t.prizePool, sorted.length);
      } else {
        prizes = this.calculateStandardPrizes(t.prizePool, sorted.length);
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

    let replayCount = 0;
    let usedAttempts = 0;
    let attemptsLeft = 0;
    let nextReplayPrice: number | null = null;
    let bestScore = 0;

    if (token) {
      try {
        userId = this.getUserIdFromToken(token);

        const participant = await this.prisma.tournamentParticipant.findUnique({
          where: {
            userId_tournamentId: {
              userId,
              tournamentId: tournament.id,
            },
          },
        });

        joined = !!participant;

        if (participant) {
          replayCount = participant.replayCount ?? 0;
          usedAttempts = participant.usedAttempts ?? 0;
          bestScore = participant.score ?? 0;
          attemptsLeft = Math.max(
            0,
            this.getAllowedAttempts(replayCount) - usedAttempts,
          );
          nextReplayPrice = this.getReplayPrice(replayCount);
        }

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

      replayCount,
      usedAttempts,
      attemptsLeft,
      nextReplayPrice,
      bestScore,

      participants: participants.map((p) => ({
        userId: p.userId,
        username: p.user.username ?? p.user.firstName ?? null,
        score: p.score,
      })),
    };
  }
}
