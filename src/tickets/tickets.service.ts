import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TicketsService {
  private readonly STARS_PER_TICKET = 2000;

  constructor(private prisma: PrismaService) {}

  async getTicketsCount(userId: number) {
    return this.prisma.ticket.count({
      where: {
        userId,
        usedAt: null,
      },
    });
  }

  async exchangeStars(userId: number) {
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
      });

      if (!user) throw new Error('USER_NOT_FOUND');

      if (user.stars < this.STARS_PER_TICKET) {
        throw new Error('NOT_ENOUGH_STARS');
      }

      await tx.user.update({
        where: { id: userId },
        data: {
          stars: { decrement: this.STARS_PER_TICKET },
        },
      });

      const ticket = await tx.ticket.create({
        data: {
          userId,
          type: 'TOURNAMENT',
        },
      });

      return {
        ticketId: ticket.id,
        starsLeft: user.stars - this.STARS_PER_TICKET,
      };
    });
  }
}
