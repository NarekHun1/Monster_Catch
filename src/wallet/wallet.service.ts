import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { WithdrawalCurrency, WithdrawalStatus } from '@prisma/client';

@Injectable()
export class WalletService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private getCoinPriceUsd(): number {
    const v = this.config.get<string>('COIN_PRICE_USD') ?? '0.02';
    return Number(v);
  }

  private getMinWithdrawUsd(): number {
    const v = this.config.get<string>('MIN_WITHDRAW_USD') ?? '5';
    return Number(v);
  }

  async getInfo(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        withdrawals: {
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    });

    if (!user) throw new NotFoundException('USER_NOT_FOUND');

    const coinPriceUsd = this.getCoinPriceUsd();
    const minWithdrawUsd = this.getMinWithdrawUsd();
    const minWithdrawCoins = Math.ceil(minWithdrawUsd / coinPriceUsd);

    const approxUsd = Number((user.coins * coinPriceUsd).toFixed(2));

    return {
      coins: user.coins,
      approxUsd,
      coinPriceUsd,
      minWithdrawUsd,
      minWithdrawCoins,
      usdtAddress: user.usdtAddress,
      tonAddress: user.tonAddress,
      recentWithdrawals: user.withdrawals.map((w) => ({
        id: w.id,
        createdAt: w.createdAt,
        coinsAmount: w.coinsAmount,
        usdAmount: w.usdAmount,
        currency: w.currency,
        status: w.status,
        txHash: w.txHash,
      })),
    };
  }

  async linkAddress(
    userId: number,
    type: 'USDT' | 'TON',
    address: string,
  ) {
    if (!address || address.trim().length < 5) {
      throw new BadRequestException('ADDRESS_TOO_SHORT');
    }

    const data: any = {};
    if (type === 'USDT') data.usdtAddress = address.trim();
    if (type === 'TON') data.tonAddress = address.trim();

    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    return {
      usdtAddress: user.usdtAddress,
      tonAddress: user.tonAddress,
    };
  }

  async requestWithdrawal(
    userId: number,
    currency: WithdrawalCurrency,
    coinsAmount: number,
  ) {
    if (coinsAmount <= 0) {
      throw new BadRequestException('AMOUNT_MUST_BE_POSITIVE');
    }

    const coinPriceUsd = this.getCoinPriceUsd();
    const minWithdrawUsd = this.getMinWithdrawUsd();
    const minWithdrawCoins = Math.ceil(minWithdrawUsd / coinPriceUsd);

    if (coinsAmount < minWithdrawCoins) {
      throw new BadRequestException('AMOUNT_TOO_SMALL');
    }

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
      });

      if (!user) {
        throw new NotFoundException('USER_NOT_FOUND');
      }

      if (user.coins < coinsAmount) {
        throw new BadRequestException('NOT_ENOUGH_COINS');
      }

      let address: string | null = null;
      if (currency === 'USDT') address = user.usdtAddress;
      if (currency === 'TON') address = user.tonAddress;

      if (!address) {
        throw new BadRequestException('ADDRESS_NOT_LINKED');
      }

      const usdAmount = Number((coinsAmount * coinPriceUsd).toFixed(2));

      // списываем монеты + создаём заявку
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: {
          coins: { decrement: coinsAmount },
        },
      });

      const withdrawal = await tx.withdrawal.create({
        data: {
          userId,
          coinsAmount,
          usdAmount,
          currency,
          address,
          status: WithdrawalStatus.PENDING,
        },
      });

      return {
        userCoins: updatedUser.coins,
        withdrawalId: withdrawal.id,
        status: withdrawal.status,
        usdAmount: withdrawal.usdAmount,
      };
    });
  }
}
