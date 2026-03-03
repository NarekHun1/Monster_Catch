// src/market/market.service.ts
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';

type Currency = 'COINS' | 'STARS';

@Injectable()
export class MarketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  private getUserId(authHeader: string): number {
    return this.auth.getUserIdFromToken(authHeader);
  }

  private async ensureUnlocked(userId: number) {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { marketUnlocked: true },
    });
    if (!u?.marketUnlocked) {
      throw new ForbiddenException('Market locked. Need 200 coins to unlock.');
    }
  }

  // ─────────────────────────────────────────────
  // LISTINGS (public) — можно смотреть всем
  // ─────────────────────────────────────────────
  async getListings() {
    const rows = await this.prisma.marketListing.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        monster: true,
        seller: { select: { id: true, username: true, firstName: true } },
        userMonster: { select: { level: true } }, // lvl продавца
      },
    });

    return rows.map((r) => ({
      id: r.id,
      price: r.price,
      currency: r.currency,
      createdAt: r.createdAt,
      fromSlotIndex: r.fromSlotIndex,
      seller: {
        id: r.seller.id,
        name: r.seller.username || r.seller.firstName || 'Player',
      },
      monster: {
        monsterId: r.monsterId,
        key: r.monster.key,
        name: r.monster.name,
        rarity: r.monster.rarity,
        imgUrl: r.monster.imgUrl,
        level: r.userMonster.level,
      },
    }));
  }

  // ─────────────────────────────────────────────
  // MY LISTINGS (private)
  // ─────────────────────────────────────────────
  async getMyListings(authHeader: string) {
    const userId = this.getUserId(authHeader);
    await this.ensureUnlocked(userId);

    const rows = await this.prisma.marketListing.findMany({
      where: { sellerId: userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        monster: true,
        userMonster: { select: { level: true } },
      },
    });

    return rows.map((r) => ({
      id: r.id,
      price: r.price,
      currency: r.currency,
      createdAt: r.createdAt,
      fromSlotIndex: r.fromSlotIndex,
      monster: {
        monsterId: r.monsterId,
        key: r.monster.key,
        name: r.monster.name,
        rarity: r.monster.rarity,
        imgUrl: r.monster.imgUrl,
        level: r.userMonster.level,
      },
    }));
  }

  // ─────────────────────────────────────────────
  // ACTIVATE (pay 200 coins)
  // ─────────────────────────────────────────────
  async activate(authHeader: string) {
    const userId = this.getUserId(authHeader);
    const COST = 200;

    const updated = await this.prisma.user.updateMany({
      where: { id: userId, marketUnlocked: false, coins: { gte: COST } },
      data: { coins: { decrement: COST }, marketUnlocked: true },
    });

    if (updated.count === 1) return { ok: true };

    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { marketUnlocked: true, coins: true },
    });

    if (u?.marketUnlocked) return { ok: true, already: true };
    throw new ForbiddenException('Need 200 coins to unlock market');
  }

  // ─────────────────────────────────────────────
  // CREATE LISTING (sell)
  // Only: monster is on farm AND level >= 5
  // ─────────────────────────────────────────────
  async listFromFarm(
    authHeader: string,
    body: { userMonsterId: number; price: number; currency: Currency },
  ) {
    const userId = this.getUserId(authHeader);
    await this.ensureUnlocked(userId);

    if (!body.userMonsterId || body.userMonsterId < 1) {
      throw new BadRequestException('userMonsterId is required');
    }
    if (!body.price || body.price < 1) {
      throw new BadRequestException('price must be >= 1');
    }
    if (body.price > 1_000_000) {
      throw new BadRequestException('price too high');
    }
    if (body.currency !== 'COINS' && body.currency !== 'STARS') {
      throw new BadRequestException('currency must be COINS or STARS');
    }

    return this.prisma.$transaction(async (tx) => {
      // ✅ (повторно) check unlocked в транзакции — чтобы 100% консистентно
      const u = await tx.user.findUnique({
        where: { id: userId },
        select: { marketUnlocked: true },
      });
      if (!u?.marketUnlocked) {
        throw new ForbiddenException('Market locked. Need 200 coins to unlock.');
      }

      const um = await tx.userMonster.findUnique({
        where: { id: body.userMonsterId },
        select: { id: true, userId: true, monsterId: true, count: true, level: true },
      });

      if (!um || um.userId !== userId) throw new ForbiddenException('Monster not yours');
      if (um.count <= 0) throw new BadRequestException('You have 0 of this monster');
      if (um.level < 5) throw new ForbiddenException('Можно продавать только монстров 5 уровня');

      // ✅ должен стоять в слотах фермы
      const slot = await tx.farmSlot.findFirst({
        where: { userId, userMonsterId: um.id, isUnlocked: true },
        select: { id: true, slotIndex: true },
      });
      if (!slot) {
        throw new BadRequestException('Можно продавать только монстров, которые стоят на Farm');
      }

      // ✅ нельзя если идёт охота
      const hunt = await tx.monsterHunt.findUnique({
        where: { userMonsterId: um.id },
        select: { status: true, endsAt: true },
      });
      if (hunt && hunt.status === 'RUNNING' && hunt.endsAt.getTime() > Date.now()) {
        throw new ForbiddenException('Monster is on hunt');
      }

      // ✅ создать лот (unique по userMonsterId защитит от дублей)
      const listing = await tx.marketListing.create({
        data: {
          sellerId: userId,
          userMonsterId: um.id,
          monsterId: um.monsterId,
          price: body.price,
          currency: body.currency,
          status: 'ACTIVE',
          fromSlotIndex: slot.slotIndex,
        },
      });

      // ✅ освободить слот (чтобы не кормился пока продаётся)
      await tx.farmSlot.update({
        where: { id: slot.id },
        data: { userMonsterId: null, fedCountToday: 0, lastFedAt: null },
      });

      return { ok: true, listingId: listing.id };
    });
  }

  // ─────────────────────────────────────────────
  // BUY
  // ─────────────────────────────────────────────
  async buy(authHeader: string, listingId: number) {
    const buyerId = this.getUserId(authHeader);
    await this.ensureUnlocked(buyerId);

    if (!listingId || listingId < 1) throw new BadRequestException('listingId is required');

    return this.prisma.$transaction(async (tx) => {
      // ✅ check unlocked in tx
      const buyerUnlock = await tx.user.findUnique({
        where: { id: buyerId },
        select: { marketUnlocked: true },
      });
      if (!buyerUnlock?.marketUnlocked) {
        throw new ForbiddenException('Market locked. Need 200 coins to unlock.');
      }

      const listing = await tx.marketListing.findUnique({
        where: { id: listingId },
        select: {
          id: true,
          sellerId: true,
          userMonsterId: true,
          monsterId: true,
          price: true,
          currency: true,
          status: true,
        },
      });

      if (!listing || listing.status !== 'ACTIVE') {
        throw new BadRequestException('Listing not active');
      }
      if (listing.sellerId === buyerId) {
        throw new BadRequestException('Cannot buy your own listing');
      }

      // ✅ lock listing
      const locked = await tx.marketListing.updateMany({
        where: { id: listing.id, status: 'ACTIVE' },
        data: { status: 'SOLD', buyerId, soldAt: new Date() },
      });
      if (locked.count === 0) throw new BadRequestException('Already sold');

      // ✅ проверить наличие монстра у продавца
      const sellerUM = await tx.userMonster.findUnique({
        where: { id: listing.userMonsterId },
        select: { id: true, userId: true, count: true },
      });
      if (!sellerUM || sellerUM.userId !== listing.sellerId || sellerUM.count <= 0) {
        throw new BadRequestException('Monster not available');
      }

      // ✅ списание/начисление
      if (listing.currency === 'COINS') {
        const buyer = await tx.user.findUnique({
          where: { id: buyerId },
          select: { coins: true },
        });
        if (!buyer || buyer.coins < listing.price) throw new ForbiddenException('Not enough coins');

        await tx.user.update({
          where: { id: buyerId },
          data: { coins: { decrement: listing.price } },
        });
        await tx.user.update({
          where: { id: listing.sellerId },
          data: { coins: { increment: listing.price } },
        });
      } else {
        const buyer = await tx.user.findUnique({
          where: { id: buyerId },
          select: { stars: true },
        });
        if (!buyer || buyer.stars < listing.price) throw new ForbiddenException('Not enough stars');

        await tx.user.update({
          where: { id: buyerId },
          data: { stars: { decrement: listing.price } },
        });
        await tx.user.update({
          where: { id: listing.sellerId },
          data: { stars: { increment: listing.price } },
        });
      }

      // ✅ передать 1 штуку
      await tx.userMonster.update({
        where: { id: sellerUM.id },
        data: { count: { decrement: 1 } },
      });

      await tx.userMonster.upsert({
        where: { userId_monsterId: { userId: buyerId, monsterId: listing.monsterId } },
        create: { userId: buyerId, monsterId: listing.monsterId, count: 1 },
        update: { count: { increment: 1 } },
      });

      return { ok: true };
    });
  }

  // ─────────────────────────────────────────────
  // CANCEL (seller only)
  // ─────────────────────────────────────────────
  async cancel(authHeader: string, listingId: number) {
    const userId = this.getUserId(authHeader);
    await this.ensureUnlocked(userId);

    if (!listingId || listingId < 1) throw new BadRequestException('listingId is required');

    return this.prisma.$transaction(async (tx) => {
      // ✅ check unlocked in tx
      const u = await tx.user.findUnique({
        where: { id: userId },
        select: { marketUnlocked: true },
      });
      if (!u?.marketUnlocked) {
        throw new ForbiddenException('Market locked. Need 200 coins to unlock.');
      }

      const listing = await tx.marketListing.findUnique({
        where: { id: listingId },
        select: { id: true, sellerId: true, status: true },
      });
      if (!listing || listing.status !== 'ACTIVE') {
        throw new BadRequestException('Listing not active');
      }
      if (listing.sellerId !== userId) throw new ForbiddenException('Not yours');

      await tx.marketListing.update({
        where: { id: listingId },
        data: { status: 'CANCELED' },
      });

      return { ok: true };
    });
  }
}
