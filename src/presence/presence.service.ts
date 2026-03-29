import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PresenceService {
  constructor(private readonly prisma: PrismaService) {}

  async ping(userId: number, screen?: string, inGame = false) {
    return this.prisma.onlinePresence.upsert({
      where: { userId },
      update: {
        lastActiveAt: new Date(),
        screen: screen ?? null,
        inGame,
      },
      create: {
        userId,
        lastActiveAt: new Date(),
        screen: screen ?? null,
        inGame,
      },
    });
  }

  async setInGame(userId: number, inGame: boolean) {
    return this.prisma.onlinePresence.upsert({
      where: { userId },
      update: {
        inGame,
        lastActiveAt: new Date(),
      },
      create: {
        userId,
        inGame,
        lastActiveAt: new Date(),
      },
    });
  }

  async markScreen(userId: number, screen?: string) {
    return this.prisma.onlinePresence.upsert({
      where: { userId },
      update: {
        screen: screen ?? null,
        lastActiveAt: new Date(),
      },
      create: {
        userId,
        screen: screen ?? null,
        lastActiveAt: new Date(),
      },
    });
  }

  async findOnlineCandidate(excludeUserId: number, tournamentId: number) {
    const onlineSince = new Date(Date.now() - 45_000);

    const presences = await this.prisma.onlinePresence.findMany({
      where: {
        userId: { not: excludeUserId },
        lastActiveAt: { gte: onlineSince },
        inGame: false,
      },
      orderBy: {
        lastActiveAt: 'desc',
      },
      take: 30,
    });

    if (!presences.length) return null;

    const candidateIds = presences.map((x) => x.userId);

    const alreadyInTournament =
      await this.prisma.tournamentParticipant.findMany({
        where: {
          tournamentId,
          userId: { in: candidateIds },
        },
        select: { userId: true },
      });

    const alreadyInTournamentSet = new Set(
      alreadyInTournament.map((x) => x.userId),
    );

    const filtered = presences.filter(
      (x) => !alreadyInTournamentSet.has(x.userId),
    );

    if (!filtered.length) return null;

    return filtered[Math.floor(Math.random() * filtered.length)];
  }

  async getOnlineCount() {
    const onlineSince = new Date(Date.now() - 45_000);

    return this.prisma.onlinePresence.count({
      where: {
        lastActiveAt: { gte: onlineSince },
      },
    });
  }

  async cleanupStaleInGameFlags() {
    const staleSince = new Date(Date.now() - 5 * 60_000);

    return this.prisma.onlinePresence.updateMany({
      where: {
        inGame: true,
        lastActiveAt: { lt: staleSince },
      },
      data: {
        inGame: false,
      },
    });
  }
}
