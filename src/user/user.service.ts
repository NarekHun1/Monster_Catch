import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';

interface TelegramUserPayload {
  id: number;
  username?: string;
  first_name?: string;
}

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(): Promise<User[]> {
    return this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }
  async findById(id: number) {
    return this.prisma.user.findUnique({ where: { id } });
  }
  async registerReferralByTelegramId(
    inviterTelegramId: string,
    invitedUserId: number,
  ) {
    const inviter = await this.prisma.user.findUnique({
      where: { telegramId: inviterTelegramId },
    });

    if (!inviter) {
      console.log('Inviter not found for telegramId =', inviterTelegramId);
      return;
    }

    // защита от самореферала
    if (inviter.id === invitedUserId) {
      console.log('User tried to refer himself, skip');
      return;
    }

    try {
      await this.prisma.referral.upsert({
        where: {
          inviterId_invitedId: {
            inviterId: inviter.id,
            invitedId: invitedUserId,
          },
        },
        update: {}, // ничего не меняем, просто не даём создать дубль
        create: {
          inviterId: inviter.id,
          invitedId: invitedUserId,
        },
      });
    } catch (e) {
      console.log('Referral upsert error:', e);
    }
  }
  async findByTelegramId(telegramId: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { telegramId },
    });
  }
  async addCoinsByTelegramId(telegramId: string, coins: number): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { telegramId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return this.prisma.user.update({
      where: { telegramId },
      data: {
        coins: user.coins + coins,
      },
    });
  }
  async createPayment(data: {
    telegramPaymentChargeId: string;
    starsAmount: number;
    coinsAmount: number;
    payload?: string;
    userId: number;
  }) {
    return this.prisma.payment.create({
      data,
    });
  }

  async upsertFromTelegram(telegramUser: TelegramUserPayload): Promise<User> {
    const telegramId = telegramUser.id.toString();

    return this.prisma.user.upsert({
      where: { telegramId },
      update: {
        username: telegramUser.username ?? undefined,
        firstName: telegramUser.first_name ?? undefined,
        lastSeenAt: new Date(),
      },
      create: {
        telegramId,
        username: telegramUser.username ?? undefined,
        firstName: telegramUser.first_name ?? undefined,
      },
    });
  }
}
