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
    const now = new Date();

    const presences = await this.prisma.onlinePresence.findMany({
      where: {
        userId: { not: excludeUserId },
        lastActiveAt: { gte: onlineSince },
        inGame: false,
      },
      orderBy: {
        lastActiveAt: 'desc',
      },
      take: 50,
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

    const pendingInvites = await this.prisma.tournamentInvite.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { gt: now },
        OR: [
          { fromUserId: { in: candidateIds } },
          { toUserId: { in: candidateIds } },
        ],
      },
      select: {
        fromUserId: true,
        toUserId: true,
      },
    });

    const busyUserSet = new Set<number>();
    for (const inv of pendingInvites) {
      busyUserSet.add(inv.fromUserId);
      busyUserSet.add(inv.toUserId);
    }

    const filtered = presences.filter((x) => {
      if (alreadyInTournamentSet.has(x.userId)) return false;
      if (busyUserSet.has(x.userId)) return false;
      return true;
    });

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
