// src/wallet/wallet.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WithdrawalStatus } from '@prisma/client';
import { AuthService } from '../auth/auth.service';
import { TonService } from './ton.service';

const COIN_PRICE_USD = 0.006;
const MIN_WITHDRAW_USD = 0.3;
const COIN_PRICE_TON = 0.006;

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly tonService: TonService,
  ) {}

  // ------------------------------
  // Получить информацию кошелька
  // ------------------------------
  async getWalletInfo(token: string) {
    const userId = this.auth.getUserIdFromToken(token);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        withdrawals: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!user) throw new BadRequestException('USER_NOT_FOUND');

    const usdBalance = user.coins * COIN_PRICE_USD;

    return {
      coins: user.coins,
      usdBalance,
      coinPriceUsd: COIN_PRICE_USD,
      usdtAddress: user.usdtAddress,
      tonAddress: user.tonAddress,
      withdrawals: user.withdrawals,
    };
  }

  // ------------------------------
  // Сохранить адрес кошельков
  // ------------------------------
  async saveAddresses(
    token: string,
    data: { usdtAddress?: string; tonAddress?: string },
  ) {
    const userId = this.auth.getUserIdFromToken(token);

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        usdtAddress: data.usdtAddress ?? undefined,
        tonAddress: data.tonAddress ?? undefined,
      },
    });

    return {
      usdtAddress: user.usdtAddress,
      tonAddress: user.tonAddress,
    };
  }

  // ------------------------------
  // ✔ Корректный запрос на вывод
  // ------------------------------
  async requestWithdrawal(
    token: string,
    params: {
      coins: number;
      currency: 'USDT' | 'TON';
      network: string;
      addressType: 'SAVED' | 'CUSTOM';
      customAddress?: string;
    },
  ) {
    const userId = this.auth.getUserIdFromToken(token);

    // 1️⃣ Проверки суммы
    if (!Number.isFinite(params.coins) || params.coins <= 0)
      throw new BadRequestException('INVALID_COINS_AMOUNT');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('USER_NOT_FOUND');

    if (user.coins < params.coins)
      throw new BadRequestException('NOT_ENOUGH_COINS');

    const amountUsd = params.coins * COIN_PRICE_USD;
    if (amountUsd < MIN_WITHDRAW_USD)
      throw new BadRequestException('MIN_WITHDRAW_1_USD');

    // 2️⃣ Определяем адрес
    let address: string;

    if (params.addressType === 'SAVED') {
      if (params.currency === 'USDT') {
        if (!user.usdtAddress)
          throw new BadRequestException('SAVED_ADDRESS_NOT_SET');
        address = user.usdtAddress;
      } else {
        if (!user.tonAddress)
          throw new BadRequestException('TON_ADDRESS_NOT_SET');
        address = user.tonAddress;

        // запрет вывода на адрес проекта
        if (address === this.tonService.walletAddress)
          throw new BadRequestException('CANNOT_WITHDRAW_TO_SAME_WALLET');
      }
    } else {
      const custom = params.customAddress?.trim();
      if (!custom) throw new BadRequestException('ADDRESS_REQUIRED');
      address = custom;
    }

    // 3️⃣ Проверка DEPLOY для TON перед списанием
    if (params.currency === 'TON') {
      const deployed = await this.tonService.isWalletDeployed(address);
      if (!deployed) throw new BadRequestException('TON_WALLET_NOT_ACTIVATED');
    }

    // 4️⃣ Создаем запись и списываем монеты
    const { withdrawal } = await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { coins: { decrement: params.coins } },
      });

      const w = await tx.withdrawal.create({
        data: {
          userId,
          coins: params.coins,
          amountUsd,
          amountTon: params.currency === 'TON' ? 0 : null,
          currency: params.currency,
          network: params.network,
          address,
          status: WithdrawalStatus.PENDING,
        },
      });

      return { withdrawal: w };
    });

    let txHash: string | null = null;
    let amountTon: number | null = null;
    let finalStatus: WithdrawalStatus = WithdrawalStatus.PENDING;

    // 5️⃣ Отправка TON
    if (params.currency === 'TON') {
      try {
        amountTon = params.coins * COIN_PRICE_TON;
        txHash = await this.tonService.sendTon(address, String(amountTon));

        await this.prisma.withdrawal.update({
          where: { id: withdrawal.id },
          data: {
            status: WithdrawalStatus.PAID,
            amountTon,
            txHash,
            processedAt: new Date(),
          },
        });

        finalStatus = WithdrawalStatus.PAID;
      } catch (e) {
        console.error('TON SEND FAILED:', e);

        // 🔥 Возврат монет пользователю
        await this.prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: userId },
            data: { coins: { increment: params.coins } },
          });

          await tx.withdrawal.update({
            where: { id: withdrawal.id },
            data: {
              status: WithdrawalStatus.REJECTED,
            },
          });
        });

        throw new BadRequestException('TON_TRANSFER_FAILED');
      }
    }

    return {
      id: withdrawal.id,
      status: finalStatus,
      coins: withdrawal.coins,
      amountUsd: withdrawal.amountUsd,
      txHash,
      amountTon,
    };
  }
}
