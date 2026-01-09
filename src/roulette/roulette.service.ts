import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TicketType } from '@prisma/client';
import { PrizeType, ROULETTE_SECTORS } from './roulette.config';

export type SpinResponse = {
  sectorId: string;
  label: string;
  type: PrizeType;
  amount?: number;
  costCoins: number;
  freeTodayUsed: boolean;
};

const PAID_SPIN_COST = 10;

// День по Asia/Yerevan (UTC+4)
function yerevanDayKey(d: Date) {
  const offsetMs = 4 * 60 * 60 * 1000;
  const local = new Date(d.getTime() + offsetMs);
  return local.toISOString().slice(0, 10); // YYYY-MM-DD
}

@Injectable()
export class RouletteService {
  constructor(private readonly prisma: PrismaService) {}

  private pickSector() {
    const total = ROULETTE_SECTORS.reduce((s, x) => s + x.weight, 0);
    let r = Math.random() * total;

    for (const s of ROULETTE_SECTORS) {
      r -= s.weight;
      if (r <= 0) return s;
    }
    return ROULETTE_SECTORS[0];
  }

  async spin(userId: number): Promise<SpinResponse> {
    const now = new Date();
    const todayKey = yerevanDayKey(now);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isBlocked: true,
        coins: true,
        rouletteFreeDay: true,
      },
    });

    if (!user) throw new BadRequestException('User not found');
    if (user.isBlocked) throw new BadRequestException('User is blocked');

    const freeAlreadyUsed = user.rouletteFreeDay === todayKey;
    const costCoins = freeAlreadyUsed ? PAID_SPIN_COST : 0;

    if (costCoins > 0 && user.coins < costCoins) {
      throw new BadRequestException('Not enough coins');
    }

    const sector = this.pickSector();

    await this.prisma.$transaction(async (tx) => {
      // 1) отметка бесплатного спина или списание 10 coins
      if (costCoins > 0) {
        await tx.user.update({
          where: { id: userId },
          data: { coins: { decrement: costCoins } },
        });
      } else {
        await tx.user.update({
          where: { id: userId },
          data: { rouletteFreeDay: todayKey },
        });
      }

      // 2) награда
      if (sector.type === 'COINS' && sector.amount) {
        await tx.user.update({
          where: { id: userId },
          data: { coins: { increment: sector.amount } },
        });
      }

      if (sector.type === 'STARS' && sector.amount) {
        await tx.user.update({
          where: { id: userId },
          data: { stars: { increment: sector.amount } },
        });
      }

      if (sector.type === 'TICKETS' && sector.amount) {
        await tx.ticket.createMany({
          data: Array.from({ length: sector.amount }).map(() => ({
            userId,
            type: TicketType.ROULETTE,
          })),
        });
      }

      if (sector.type === 'JACKPOT') {
        const jackpotCoins = sector.amount ?? 100;
        await tx.user.update({
          where: { id: userId },
          data: { coins: { increment: jackpotCoins } },
        });
      }

      await tx.user.update({
        where: { id: userId },
        data: { rouletteLastSpinAt: now },
      });
    });

    return {
      sectorId: sector.id,
      label: sector.label,
      type: sector.type,
      amount: sector.amount,
      costCoins,
      freeTodayUsed: freeAlreadyUsed,
    };
  }
}
