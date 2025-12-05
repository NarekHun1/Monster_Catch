import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class WalletService {
  constructor(private prisma: PrismaService) {}

  private readonly COINS_PER_USD = 50;
  private readonly USD_PER_TON = 2; // примерный курс 1 TON ≈ 2$

  async requestWithdraw(userId: number, coins: number, network: string, address: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('Пользователь не найден');

    if (user.coins < coins) {
      throw new BadRequestException('Недостаточно монет');
    }

    if (!address || address.length < 10) {
      throw new BadRequestException('Неверный адрес кошелька');
    }

    // Рассчёт суммы
    const amountUsd = coins / this.COINS_PER_USD;
    const amountTon = amountUsd / this.USD_PER_TON;

    // Создаём заявку
    const withdrawal = await this.prisma.withdrawal.create({
      data: {
        userId,
        coins,
        amountUsd,
        amountTon,
        currency: 'TON',
        network,
        address,
      },
    });

    // Списываем монеты
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        coins: {
          decrement: coins,
        },
      },
    });

    return {
      success: true,
      withdrawalId: withdrawal.id,
      amountUsd,
      amountTon,
    };
  }

  async listUserWithdrawals(userId: number) {
    return this.prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
