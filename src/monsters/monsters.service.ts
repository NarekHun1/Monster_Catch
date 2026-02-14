// src/monsters/monsters.service.ts
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';

@Injectable()
export class MonstersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  // ─────────────────────────────────────────────
  // XP / LEVEL
  // LVL cap = 5 (no levels above 5)
  // ─────────────────────────────────────────────
  private readonly MAX_LEVEL = 5;

  xpForNextLevel(level: number) {
    // 1->2: 30, 2->3: 60, 3->4: 90, 4->5: 120
    return level * 30;
  }

  private getUserId(authHeader: string): number {
    return this.auth.getUserIdFromToken(authHeader);
  }

  // ─────────────────────────────────────────────
  // COLLECTION
  // ─────────────────────────────────────────────
  async getCollection(authHeader: string) {
    const userId = this.getUserId(authHeader);

    const rows = await this.prisma.userMonster.findMany({
      where: { userId },
      include: { monster: true },
      orderBy: [{ count: 'desc' }, { updatedAt: 'desc' }],
    });

    const totalCaught = rows.reduce((s, r) => s + r.count, 0);

    return {
      totalCaught,
      monsters: rows.map((r) => {
        const level = Math.min(this.MAX_LEVEL, r.level);

        return {
          userMonsterId: r.id,
          monsterId: r.monsterId,
          key: r.monster.key,
          name: r.monster.name,
          rarity: r.monster.rarity,
          imgUrl: r.monster.imgUrl,
          count: r.count,
          level,
          // после 5 уровня xp не нужен
          xp: level >= this.MAX_LEVEL ? 0 : r.xp,
          xpNext: level >= this.MAX_LEVEL ? 0 : this.xpForNextLevel(level),
          feedCountForHunt: r.feedCountForHunt, // если у тебя есть это поле — фронту удобно
        };
      }),
    };
  }

  // ─────────────────────────────────────────────
  // FARM
  // ─────────────────────────────────────────────
  async getFarm(authHeader: string) {
    const userId = this.getUserId(authHeader);

    await this.ensureFarmSlots(userId, 8);

    const [user, slots] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { meat: true },
      }),
      this.prisma.farmSlot.findMany({
        where: { userId },
        orderBy: { slotIndex: 'asc' },
        include: {
          userMonster: {
            include: { monster: true },
          },
        },
      }),
    ]);

    if (!user) throw new UnauthorizedException('User not found');

    return {
      meat: user.meat,
      slots: slots.map((s) => {
        const um = s.userMonster;
        const lvl = um ? Math.min(this.MAX_LEVEL, um.level) : null;

        return {
          slotIndex: s.slotIndex,
          isUnlocked: s.isUnlocked,
          unlockPrice: s.unlockPrice,

          // оставляю для совместимости с твоим фронтом
          fedCountToday: s.fedCountToday,
          lastFedAt: s.lastFedAt,

          monster: um
            ? {
              userMonsterId: um.id,
              monsterId: um.monsterId,
              key: um.monster.key,
              name: um.monster.name,
              rarity: um.monster.rarity,
              imgUrl: um.monster.imgUrl,
              count: um.count,
              level: lvl!,
              xp: lvl! >= this.MAX_LEVEL ? 0 : um.xp,
              xpNext: lvl! >= this.MAX_LEVEL ? 0 : this.xpForNextLevel(lvl!),
              feedCountForHunt: um.feedCountForHunt,
            }
            : null,
        };
      }),
    };
  }

  private huntEndsInHours(hours: number) {
    const ms = hours * 60 * 60 * 1000;
    return new Date(Date.now() + ms);
  }

  private secondsLeft(endsAt: Date) {
    return Math.max(0, Math.floor((endsAt.getTime() - Date.now()) / 1000));
  }

  private rollHuntReward() {
    const r = Math.random() * 100;

    // 15% ничего
    if (r < 15) return { stars: 0, tickets: 0, coins: 0, meat: 0 };

    // 25%: 10 stars 1 bilet 1 coin
    if (r < 40) return { stars: 10, tickets: 1, coins: 1, meat: 0 };

    // 20%: 10 meat 10 stars 1 bilet
    if (r < 60) return { stars: 10, tickets: 1, coins: 0, meat: 10 };

    // 20%: 5 meat 5 stars 1 coin
    if (r < 80) return { stars: 5, tickets: 0, coins: 1, meat: 5 };

    // 20%: 10 meat
    return { stars: 0, tickets: 0, coins: 0, meat: 10 };
  }

  async getHuntStatus(authHeader: string, userMonsterId: number) {
    const userId = this.getUserId(authHeader);

    const um = await this.prisma.userMonster.findUnique({
      where: { id: userMonsterId },
      include: { hunt: true },
    });
    if (!um || um.userId !== userId)
      throw new BadRequestException('Monster not yours');

    const hunt = um.hunt;
    if (hunt && hunt.status === 'RUNNING') {
      const left = this.secondsLeft(hunt.endsAt);
      return {
        ok: true,
        status: left > 0 ? 'RUNNING' : 'READY',
        endsAt: hunt.endsAt,
        secondsLeft: left,
        feedCountForHunt: um.feedCountForHunt,
        canStart: false,
        canClaim: left === 0,
      };
    }

    const canStart = um.level >= this.MAX_LEVEL && um.feedCountForHunt >= 100;
    return {
      ok: true,
      status: 'IDLE',
      endsAt: null,
      secondsLeft: 0,
      feedCountForHunt: um.feedCountForHunt,
      canStart,
      canClaim: false,
    };
  }

  async startHunt(authHeader: string, userMonsterId: number) {
    const userId = this.getUserId(authHeader);

    const um = await this.prisma.userMonster.findUnique({
      where: { id: userMonsterId },
      include: { hunt: true },
    });
    if (!um || um.userId !== userId)
      throw new BadRequestException('Monster not yours');

    // ✅ только 5 уровень (выше у нас не бывает)
    if (um.level < this.MAX_LEVEL)
      throw new ForbiddenException('Monster level must be 5');

    // ✅ каждый раз нужно 100 кормлений
    if (um.feedCountForHunt < 100)
      throw new ForbiddenException('Need 100 feedings to hunt');

    if (um.hunt && um.hunt.status === 'RUNNING') {
      const left = this.secondsLeft(um.hunt.endsAt);
      if (left > 0) throw new BadRequestException('Hunt already running');
      throw new BadRequestException('Hunt is ready — claim it first');
    }

    const endsAt = this.huntEndsInHours(24);

    const hunt = await this.prisma.monsterHunt.upsert({
      where: { userMonsterId },
      create: {
        userId,
        userMonsterId,
        status: 'RUNNING',
        endsAt,
      },
      update: {
        userId,
        status: 'RUNNING',
        startedAt: new Date(),
        endsAt,
        rewardStars: 0,
        rewardTickets: 0,
        rewardCoins: 0,
        rewardMeat: 0,
      },
    });

    return {
      ok: true,
      status: 'RUNNING',
      endsAt: hunt.endsAt,
      secondsLeft: this.secondsLeft(hunt.endsAt),
    };
  }

  async claimHunt(authHeader: string, userMonsterId: number) {
    const userId = this.getUserId(authHeader);

    const hunt = await this.prisma.monsterHunt.findUnique({
      where: { userMonsterId },
    });
    if (!hunt || hunt.userId !== userId)
      throw new BadRequestException('No hunt');

    if (hunt.status !== 'RUNNING')
      throw new BadRequestException('Already claimed');

    const left = this.secondsLeft(hunt.endsAt);
    if (left > 0) throw new ForbiddenException('Not ready yet');

    const reward = this.rollHuntReward();

    const result = await this.prisma.$transaction(async (tx) => {
      // 1) начислить награду
      await tx.user.update({
        where: { id: userId },
        data: {
          stars: { increment: reward.stars },
          coins: { increment: reward.coins },
          meat: { increment: reward.meat },
        },
        select: { id: true },
      });

      // tickets — через Ticket таблицу
      if (reward.tickets > 0) {
        await tx.ticket.createMany({
          data: Array.from({ length: reward.tickets }, () => ({
            userId,
            type: 'ROULETTE', // или HUNT — если добавишь enum
          })),
        });
      }

      // 2) зафиксировать reward и закрыть hunt
      const updatedHunt = await tx.monsterHunt.update({
        where: { userMonsterId },
        data: {
          status: 'CLAIMED',
          rewardStars: reward.stars,
          rewardTickets: reward.tickets,
          rewardCoins: reward.coins,
          rewardMeat: reward.meat,
        },
      });

      // 3) сбросить прогресс 100 кормлений (чтобы каждый раз заново)
      await tx.userMonster.update({
        where: { id: userMonsterId },
        data: { feedCountForHunt: 0 },
      });

      return updatedHunt;
    });

    return {
      ok: true,
      reward,
      hunt: {
        status: result.status,
        endsAt: result.endsAt,
      },
    };
  }

  async unlockSlot(authHeader: string, slotIndex: number) {
    const userId = this.getUserId(authHeader);

    if (!Number.isFinite(slotIndex) || slotIndex < 1) {
      throw new BadRequestException('Invalid slotIndex');
    }

    await this.ensureFarmSlots(userId, 8);

    const slot = await this.prisma.farmSlot.findUnique({
      where: { userId_slotIndex: { userId, slotIndex } },
    });
    if (!slot) throw new BadRequestException('Slot not found');
    if (slot.isUnlocked) return { ok: true, already: true };

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { coins: true },
    });
    if (!user) throw new UnauthorizedException('User not found');

    if (user.coins < slot.unlockPrice) {
      throw new ForbiddenException('Not enough coins');
    }

    const [updatedUser, updatedSlot] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { coins: { decrement: slot.unlockPrice } },
        select: { coins: true },
      }),
      this.prisma.farmSlot.update({
        where: { userId_slotIndex: { userId, slotIndex } },
        data: { isUnlocked: true },
        select: { slotIndex: true, isUnlocked: true },
      }),
    ]);

    return { ok: true, coins: updatedUser.coins, slot: updatedSlot };
  }

  async assignToSlot(
    authHeader: string,
    slotIndex: number,
    userMonsterId: number,
  ) {
    const userId = this.getUserId(authHeader);

    if (!Number.isFinite(slotIndex) || slotIndex < 1) {
      throw new BadRequestException('Invalid slotIndex');
    }
    if (!Number.isFinite(userMonsterId) || userMonsterId < 1) {
      throw new BadRequestException('Invalid userMonsterId');
    }

    await this.ensureFarmSlots(userId, 8);

    const slot = await this.prisma.farmSlot.findUnique({
      where: { userId_slotIndex: { userId, slotIndex } },
    });
    if (!slot) throw new BadRequestException('Slot not found');
    if (!slot.isUnlocked) throw new ForbiddenException('Slot locked');

    const um = await this.prisma.userMonster.findUnique({
      where: { id: userMonsterId },
      include: { monster: true },
    });
    if (!um || um.userId !== userId) {
      throw new BadRequestException('Monster not yours');
    }
    if (um.count <= 0) {
      throw new BadRequestException('You have 0 of this monster');
    }

    await this.prisma.farmSlot.update({
      where: { userId_slotIndex: { userId, slotIndex } },
      data: { userMonsterId: um.id },
    });

    return { ok: true };
  }

  // ─────────────────────────────────────────────
  // FEED
  // Rules:
  // - MAX LEVEL = 5 (no levels above 5)
  // - after reaching 5, each feeding increments feedCountForHunt (max 100)
  // - hunt requires level 5 and feedCountForHunt >= 100
  // ─────────────────────────────────────────────
  async feed(authHeader: string, slotIndex: number) {
    const userId = this.getUserId(authHeader);

    if (!Number.isFinite(slotIndex) || slotIndex < 1) {
      throw new BadRequestException('Invalid slotIndex');
    }

    const slot = await this.prisma.farmSlot.findUnique({
      where: { userId_slotIndex: { userId, slotIndex } },
      include: { userMonster: true },
    });

    if (!slot) throw new BadRequestException('Slot not found');
    if (!slot.isUnlocked) throw new ForbiddenException('Slot locked');
    if (!slot.userMonster) throw new BadRequestException('No monster in slot');

    const um = slot.userMonster;

    // ✅ запретить кормить если монстр на охоте
    const running = await this.prisma.monsterHunt.findUnique({
      where: { userMonsterId: um.id },
    });
    if (
      running &&
      running.status === 'RUNNING' &&
      this.secondsLeft(running.endsAt) > 0
    ) {
      throw new ForbiddenException('Monster is on hunt');
    }

    const MEAT_COST = 1;

    let level = Math.min(this.MAX_LEVEL, um.level);
    let xp = um.xp;

    // ✅ уровень растёт только до 5
    if (level < this.MAX_LEVEL) {
      xp = um.xp + 1;

      while (level < this.MAX_LEVEL && xp >= this.xpForNextLevel(level)) {
        xp -= this.xpForNextLevel(level);
        level += 1;
      }

      // дошли до 5 — XP больше не храним
      if (level >= this.MAX_LEVEL) {
        level = this.MAX_LEVEL;
        xp = 0;
      }
    } else {
      // на 5 уровне XP не растёт
      level = this.MAX_LEVEL;
      xp = 0;
    }

    const [meatLeft, updatedMonster] = await this.prisma.$transaction(
      async (tx) => {
        // 1) списать мясо (и проверить что хватило)
        const u = await tx.user.updateMany({
          where: { id: userId, meat: { gte: MEAT_COST } },
          data: { meat: { decrement: MEAT_COST } },
        });

        if (u.count !== 1) {
          throw new ForbiddenException('Not enough meat');
        }

        // 2) вернуть актуальный баланс мяса
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { meat: true },
        });

        // 3) аккуратно посчитать новый feedCountForHunt (cap 100) только на 5 уровне
        let nextFeedCount = um.feedCountForHunt ?? 0;
        if (level >= this.MAX_LEVEL) {
          nextFeedCount = Math.min(100, nextFeedCount + 1);
        }

        // 4) апдейт монстра
        const monster = await tx.userMonster.update({
          where: { id: um.id },
          data: {
            level,
            xp,
            ...(level >= this.MAX_LEVEL
              ? { feedCountForHunt: nextFeedCount }
              : {}),
          },
          select: { id: true, level: true, xp: true, feedCountForHunt: true },
        });

        return [user!.meat, monster] as const;
      },
    );

    return {
      ok: true,
      meatLeft,
      monster: {
        userMonsterId: updatedMonster.id,
        level: updatedMonster.level,
        xp: updatedMonster.level >= this.MAX_LEVEL ? 0 : updatedMonster.xp,
        xpNext:
          updatedMonster.level >= this.MAX_LEVEL
            ? 0
            : this.xpForNextLevel(updatedMonster.level),
        feedCountForHunt: updatedMonster.feedCountForHunt,
      },
    };
  }

  // ⚠️ DEV ONLY: give monsters for testing frontend
  async devGiveMonster(authHeader: string, monsterKey: string, count = 1) {
    const userId = this.getUserId(authHeader);

    if (!monsterKey) throw new BadRequestException('monsterKey is required');
    if (!Number.isFinite(count) || count <= 0) {
      throw new BadRequestException('count must be > 0');
    }

    const def = await this.prisma.monsterDef.findUnique({
      where: { key: monsterKey },
    });
    if (!def) throw new BadRequestException('MonsterDef not found');

    const um = await this.prisma.userMonster.upsert({
      where: { userId_monsterId: { userId, monsterId: def.id } },
      create: { userId, monsterId: def.id, count },
      update: { count: { increment: count } },
      include: { monster: true },
    });

    return {
      ok: true,
      userMonsterId: um.id,
      key: um.monster.key,
      name: um.monster.name,
      rarity: um.monster.rarity,
      imgUrl: um.monster.imgUrl,
      count: um.count,
    };
  }

  // ─────────────────────────────────────────────
  // INTERNAL: ensure slots exist (8)
  // safer: createMany + skipDuplicates
  // ─────────────────────────────────────────────
  private async ensureFarmSlots(userId: number, total: number) {
    const prices = Array.from({ length: total }, (_, i) => {
      if (i === 0) return 0; // slotIndex 1 free
      return Math.round(50 * Math.pow(1.6, i - 1));
    });

    const data = Array.from({ length: total }, (_, i) => {
      const slotIndex = i + 1;
      return {
        userId,
        slotIndex,
        isUnlocked: slotIndex === 1,
        unlockPrice: prices[i],
      };
    });

    await this.prisma.farmSlot.createMany({
      data,
      skipDuplicates: true,
    });
  }
}
