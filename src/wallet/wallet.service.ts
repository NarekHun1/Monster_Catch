// src/wallet/wallet.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WithdrawalStatus } from '@prisma/client';
import { AuthService } from '../auth/auth.service';

const COIN_PRICE_USD = 0.02; // 1 coin = 0.02$
const MIN_WITHDRAW_USD = 1; // минималка на вывод 1$

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}
  async setAddress(
    userId: number,
    data: { tonAddress?: string; usdtAddress?: string; usdtNetwork?: string },
  ) {
    return this.prisma.user.update({
      where: { id: userId },
      data: {
        tonAddress: data.tonAddress ?? undefined,
        usdtAddress: data.usdtAddress ?? undefined,
        usdtNetwork: data.usdtNetwork ?? undefined,
      },
    });
  }

  // инфо для фронта
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
      withdrawals: user.withdrawals.map((w) => ({
        id: w.id,
        createdAt: w.createdAt,
        coins: w.coins,
        amountUsd: w.amountUsd,
        amountTon: w.amountTon,
        currency: w.currency,
        network: w.network,
        address: w.address,
        status: w.status,
        txHash: w.txHash,
      })),
    };
  }

  // сохранить/обновить адреса кошельков
  async saveAddresses(
    token: string,
    data: { usdtAddress?: string; tonAddress?: string },
  ) {
    const userId = this.auth.getUserIdFromToken(token);

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        usdtAddress: data.usdtAddress ?? null,
        tonAddress: data.tonAddress ?? null,
      },
    });

    return {
      usdtAddress: user.usdtAddress,
      tonAddress: user.tonAddress,
    };
  }

  // запрос вывода
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

    if (!Number.isFinite(params.coins) || params.coins <= 0) {
      throw new BadRequestException('INVALID_COINS_AMOUNT');
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('USER_NOT_FOUND');

    if (user.coins < params.coins) {
      throw new BadRequestException('NOT_ENOUGH_COINS');
    }

    const amountUsd = params.coins * COIN_PRICE_USD;
    if (amountUsd < MIN_WITHDRAW_USD) {
      throw new BadRequestException('MIN_WITHDRAW_1_USD');
    }

    // адрес — либо сохранённый, либо кастомный
    let address: string | null = null;

    if (params.addressType === 'SAVED') {
      if (params.currency === 'USDT') address = user.usdtAddress ?? null;
      if (params.currency === 'TON') address = user.tonAddress ?? null;
      if (!address) {
        throw new BadRequestException('SAVED_ADDRESS_NOT_SET');
      }
    } else {
      address = params.customAddress?.trim() || null;
      if (!address) throw new BadRequestException('ADDRESS_REQUIRED');
    }

    const { withdrawal } = await this.prisma.$transaction(async (tx) => {
      // списываем монеты
      await tx.user.update({
        where: { id: userId },
        data: { coins: { decrement: params.coins } },
      });

      // создаём запись вывода
      const w = await tx.withdrawal.create({
        data: {
          userId,
          coins: params.coins,
          amountUsd,
          amountTon: params.currency === 'TON' ? 0 : null, // потом можешь проставлять реальный TON
          currency: params.currency, // 'USDT' | 'TON'
          network: params.network,
          address,
          status: WithdrawalStatus.PENDING,
        },
      });

      return { withdrawal: w };
    });

    return {
      id: withdrawal.id,
      status: withdrawal.status,
      coins: withdrawal.coins,
      amountUsd: withdrawal.amountUsd,
    };
  }
}
