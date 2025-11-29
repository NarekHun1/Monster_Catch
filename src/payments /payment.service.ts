// src/payment/payment.service.ts
import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserService } from '../user/user.service';

@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userService: UserService,
  ) {}

  // 🔥 Создаем запись об оплате
  async registerPayment(params: {
    telegramPaymentChargeId: string;
    starsAmount: number;
    coinsAmount: number;
    payload?: string;
    userTelegramId: string;
  }) {
    const {
      telegramPaymentChargeId,
      starsAmount,
      coinsAmount,
      payload,
      userTelegramId,
    } = params;

    // ————————————————
    // 1. Проверяем нет ли дубля
    // ————————————————
    const exists = await this.prisma.payment.findUnique({
      where: { telegramPaymentChargeId },
    });

    if (exists) {
      throw new BadRequestException('Payment already registered');
    }

    // ————————————————
    // 2. Ищем пользователя
    // ————————————————
    const user = await this.userService.findByTelegramId(userTelegramId);
    if (!user) throw new NotFoundException('User not found');

    // ————————————————
    // 3. Создаем запись
    // ————————————————
    const payment = await this.prisma.payment.create({
      data: {
        telegramPaymentChargeId,
        starsAmount,
        coinsAmount,
        payload,
        userId: user.id,
      },
    });

    // ————————————————
    // 4. Начисляем монеты ЮЗЕРУ
    // ————————————————
    if (coinsAmount > 0) {
      await this.userService.addCoins(user.id, coinsAmount);
    }

    return payment;
  }
}
