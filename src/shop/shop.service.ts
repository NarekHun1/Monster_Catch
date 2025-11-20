import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

interface JwtPayload {
  userId: number;
}

type ShopItemId = 'multiplier' | 'extra_time' | 'epic_boost';

const SHOP_ITEMS: Record<
  ShopItemId,
  { title: string; basePrice: number; maxLevel: number }
> = {
  multiplier: {
    title: 'Множитель очков',
    basePrice: 100,
    maxLevel: 10,
  },
  extra_time: {
    title: 'Доп. время раунда',
    basePrice: 80,
    maxLevel: 5,
  },
  epic_boost: {
    title: 'Шанс эпиков',
    basePrice: 120,
    maxLevel: 5,
  },
};

@Injectable()
export class ShopService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {}

  private getUserIdFromToken(authHeader?: string): number {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Missing or invalid Authorization header');
    }
    const token = authHeader.slice(7);
    const secret = this.config.get<string>('JWT_SECRET');
    const payload = jwt.verify(token, secret!) as JwtPayload;
    return payload.userId;
  }

  async getStatus(authHeader?: string) {
    const userId = this.getUserIdFromToken(authHeader);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    if (!user) throw new BadRequestException('User not found');

    const items = Object.entries(SHOP_ITEMS).map(([id, cfg]) => {
      const itemId = id as ShopItemId;
      let level = 0;
      if (itemId === 'multiplier') level = user.multiplierLevel;
      if (itemId === 'extra_time') level = user.extraTimeLevel;
      if (itemId === 'epic_boost') level = user.epicBoostLevel;

      const price = cfg.basePrice * (level + 1);

      return {
        id: itemId,
        title: cfg.title,
        level,
        maxLevel: cfg.maxLevel,
        price,
        canBuy: user.stars >= price && level < cfg.maxLevel,
      };
    });

    return {
      stars: user.stars,
      items,
    };
  }

  async buy(authHeader: string | undefined, itemId: ShopItemId) {
    const userId = this.getUserIdFromToken(authHeader);
    const cfg = SHOP_ITEMS[itemId];
    if (!cfg) throw new BadRequestException('Unknown item');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    let level = 0;
    if (itemId === 'multiplier') level = user.multiplierLevel;
    if (itemId === 'extra_time') level = user.extraTimeLevel;
    if (itemId === 'epic_boost') level = user.epicBoostLevel;

    if (level >= cfg.maxLevel) {
      throw new BadRequestException('Max level reached');
    }

    const price = cfg.basePrice * (level + 1);
    if (user.stars < price) {
      throw new BadRequestException('Not enough stars');
    }

    // списываем звёзды и увеличиваем уровень
    const data: any = {
      stars: { decrement: price },
    };
    if (itemId === 'multiplier') data.multiplierLevel = { increment: 1 };
    if (itemId === 'extra_time') data.extraTimeLevel = { increment: 1 };
    if (itemId === 'epic_boost') data.epicBoostLevel = { increment: 1 };

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data,
    });

    return {
      stars: updated.stars,
      multiplierLevel: updated.multiplierLevel,
      extraTimeLevel: updated.extraTimeLevel,
      epicBoostLevel: updated.epicBoostLevel,
    };
  }
}
