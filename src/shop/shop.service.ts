// src/shop/shop.service.ts
import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

interface JwtPayload {
  userId: number;
}

export type ShopItemId = 'multiplier' | 'extra_time' | 'epic_boost';

const SHOP_ITEMS: Record<
  ShopItemId,
  { title: string; basePrice: number; maxLevel: number }
> = {
  multiplier: { title: 'Множитель очков', basePrice: 100, maxLevel: 10 },
  extra_time: { title: 'Доп. время раунда', basePrice: 80, maxLevel: 5 },
  epic_boost: { title: 'Шанс эпиков', basePrice: 120, maxLevel: 5 },
};

function isShopItemId(x: any): x is ShopItemId {
  return x === 'multiplier' || x === 'extra_time' || x === 'epic_boost';
}

@Injectable()
export class ShopService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private getUserIdFromToken(authHeader?: string): number {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const token = authHeader.slice(7).trim();
    if (!token) throw new UnauthorizedException('Missing token');

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret) throw new UnauthorizedException('JWT secret not configured');

    try {
      const payload = jwt.verify(token, secret) as JwtPayload;
      if (!payload?.userId)
        throw new UnauthorizedException('Invalid token payload');
      return payload.userId;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  async getStatus(authHeader?: string) {
    const userId = this.getUserIdFromToken(authHeader);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        stars: true,
        multiplierLevel: true,
        extraTimeLevel: true,
        epicBoostLevel: true,
      },
    });

    if (!user) throw new UnauthorizedException('User not found');

    const items = (
      Object.entries(SHOP_ITEMS) as [
        ShopItemId,
        (typeof SHOP_ITEMS)[ShopItemId],
      ][]
    ).map(([id, cfg]) => {
      const level =
        id === 'multiplier'
          ? user.multiplierLevel
          : id === 'extra_time'
            ? user.extraTimeLevel
            : user.epicBoostLevel;

      const price = cfg.basePrice * (level + 1);

      return {
        id,
        title: cfg.title,
        level,
        maxLevel: cfg.maxLevel,
        price,
        canBuy: user.stars >= price && level < cfg.maxLevel,
      };
    });

    return { stars: user.stars, items };
  }

  async buy(authHeader: string | undefined, rawItemId: unknown) {
    const userId = this.getUserIdFromToken(authHeader);

    if (!isShopItemId(rawItemId)) {
      throw new BadRequestException('Unknown itemId');
    }
    const itemId = rawItemId;

    const cfg = SHOP_ITEMS[itemId];

    // Берём текущие значения
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        stars: true,
        multiplierLevel: true,
        extraTimeLevel: true,
        epicBoostLevel: true,
      },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const level =
      itemId === 'multiplier'
        ? user.multiplierLevel
        : itemId === 'extra_time'
          ? user.extraTimeLevel
          : user.epicBoostLevel;

    if (level >= cfg.maxLevel) {
      throw new BadRequestException('Max level reached');
    }

    const price = cfg.basePrice * (level + 1);
    if (user.stars < price) {
      throw new ForbiddenException('Not enough stars');
    }

    // ✅ Атомарная покупка (без гонок)
    const updated = await this.prisma.$transaction(async (tx) => {
      // 1) списать stars только если хватает
      const dec = await tx.user.updateMany({
        where: { id: userId, stars: { gte: price } },
        data: { stars: { decrement: price } },
      });
      if (dec.count !== 1) throw new ForbiddenException('Not enough stars');

      // 2) поднять уровень только если не достиг max
      const levelField =
        itemId === 'multiplier'
          ? 'multiplierLevel'
          : itemId === 'extra_time'
            ? 'extraTimeLevel'
            : 'epicBoostLevel';

      // проверка maxLevel через where
      const inc = await tx.user.updateMany({
        where: {
          id: userId,
          [levelField]: { lt: cfg.maxLevel },
        } as any,
        data: {
          [levelField]: { increment: 1 },
        } as any,
      });

      if (inc.count !== 1) {
        // откатываем списание? транзакция сама откатит при throw
        throw new BadRequestException('Max level reached');
      }

      // 3) вернуть актуальные значения
      return tx.user.findUnique({
        where: { id: userId },
        select: {
          stars: true,
          multiplierLevel: true,
          extraTimeLevel: true,
          epicBoostLevel: true,
        },
      });
    });

    if (!updated) throw new UnauthorizedException('User not found');

    return updated;
  }
}
