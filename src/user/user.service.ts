import { Injectable } from '@nestjs/common';
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

  async findByTelegramId(telegramId: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { telegramId },
    });
  }

  // ✔ Правильный безопасный инкремент (Prisma)
  async addCoins(userId: number, coins: number): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        coins: {
          increment: coins,
        },
      },
    });
  }

  // ✔ Доп вариант через telegramId
  async addCoinsByTelegramId(telegramId: string, coins: number): Promise<User> {
    return this.prisma.user.update({
      where: { telegramId },
      data: {
        coins: {
          increment: coins,
        },
      },
    });
  }

  // ✔ Создание записи об оплате
  async createPayment(data: {
    telegramPaymentChargeId: string;
    providerPaymentChargeId?: string | null;
    starsAmount: number;
    coinsAmount: number;
    payload?: string;
    userId: number;
  }) {
    return this.prisma.payment.create({
      data,
    });
  }

  // ✔ Upsert при входе в Telegram Mini App
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

  // ✔ Рефералка
  async registerReferralByTelegramId(
    inviterTelegramId: string,
    invitedUserId: number,
  ) {
    const inviter = await this.prisma.user.findUnique({
      where: { telegramId: inviterTelegramId },
    });

    if (!inviter) return;

    if (inviter.id === invitedUserId) return;

    try {
      await this.prisma.referral.upsert({
        where: {
          inviterId_invitedId: {
            inviterId: inviter.id,
            invitedId: invitedUserId,
          },
        },
        update: {},
        create: {
          inviterId: inviter.id,
          invitedId: invitedUserId,
        },
      });
    } catch (e) {
      console.log('Referral upsert error:', e);
    }
  }
}
