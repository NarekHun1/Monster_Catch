import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { MonsterRarity, Prisma } from '@prisma/client';

type SummonMode = 'BASIC' | 'PREMIUM';

interface SummonPreviewDto {
  mode: SummonMode;
}

@Injectable()
export class SummonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  private getUserId(authHeader: string): number {
    return this.auth.getUserIdFromToken(authHeader);
  }

  private todayResetAt() {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  }

  private async getSummonState(
    userId: number,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const client = tx as any;
    let state = await client.userSummonState.findUnique({ where: { userId } });
    const now = new Date();

    if (!state) {
      state = await client.userSummonState.create({
        data: {
          userId,
          pityBasic: 0,
          pityPremium: 0,
          dailySummons: 0,
          dailyPremiumSummons: 0,
          resetAt: this.todayResetAt(),
        },
      });
    } else if (state.resetAt <= now) {
      state = await client.userSummonState.update({
        where: { userId },
        data: {
          dailySummons: 0,
          dailyPremiumSummons: 0,
          resetAt: this.todayResetAt(),
        },
      });
    }

    return state;
  }

  private getModeConfig(mode: SummonMode) {
    if (mode === 'BASIC') {
      return {
        costCoins: 50,
        costStars: 0,
        pityField: 'pityBasic' as const,
        dailyField: 'dailySummons' as const,
        dailyLimit: 500,
        baseChances: {
          COMMON: 0.7,
          RARE: 0.25,
          EPIC: 0.049,
          LEGENDARY: 0.001,
        },
      };
    }
    // PREMIUM
    return {
      costCoins: 0,
      costStars: 5,
      pityField: 'pityPremium' as const,
      dailyField: 'dailyPremiumSummons' as const,
      dailyLimit: 200,
      baseChances: {
        COMMON: 0.4,
        RARE: 0.4,
        EPIC: 0.17,
        LEGENDARY: 0.03,
      },
    };
  }

  private applyPity(
    mode: SummonMode,
    state: Awaited<ReturnType<SummonService['getSummonState']>>,
  ) {
    const cfg = this.getModeConfig(mode);
    const pityBefore = state[cfg.pityField];

    const bonusEpic = Math.min(0.2, pityBefore * 0.01);
    const bonusLegendary = Math.min(0.1, pityBefore * 0.005);

    let { COMMON, RARE, EPIC, LEGENDARY } = cfg.baseChances;
    EPIC += bonusEpic;
    LEGENDARY += bonusLegendary;
    const total = COMMON + RARE + EPIC + LEGENDARY;
    COMMON /= total;
    RARE /= total;
    EPIC /= total;
    LEGENDARY /= total;

    return {
      pityBefore,
      cfg,
      chances: { COMMON, RARE, EPIC, LEGENDARY },
    };
  }

  private pickRarity(chances: {
    COMMON: number;
    RARE: number;
    EPIC: number;
    LEGENDARY: number;
  }): MonsterRarity {
    const r = Math.random();
    if (r < chances.LEGENDARY) return MonsterRarity.LEGENDARY;
    if (r < chances.LEGENDARY + chances.EPIC) return MonsterRarity.EPIC;
    if (r < chances.LEGENDARY + chances.EPIC + chances.RARE)
      return MonsterRarity.RARE;
    return MonsterRarity.COMMON;
  }

  private async getRandomMonsterByRarity(
    rarity: MonsterRarity,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    const list = await tx.monsterDef.findMany({
      where: { rarity, isActive: true },
      select: { id: true },
    });
    if (!list.length) throw new BadRequestException('No monsters for rarity');
    const idx = Math.floor(Math.random() * list.length);
    return list[idx].id;
  }

  async getState(authHeader: string) {
    const userId = this.getUserId(authHeader);
    const [user, state] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { coins: true, stars: true },
      }),
      this.getSummonState(userId),
    ]);

    if (!user) throw new UnauthorizedException('User not found');

    return {
      ok: true,
      coins: user.coins,
      stars: user.stars,
      state,
    };
  }

  async preview(authHeader: string, dto: SummonPreviewDto) {
    const userId = this.getUserId(authHeader);
    if (!dto.mode) throw new BadRequestException('mode is required');

    const [user, state] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { coins: true, stars: true },
      }),
      this.getSummonState(userId),
    ]);

    if (!user) throw new UnauthorizedException('User not found');

    const { cfg, pityBefore, chances } = this.applyPity(dto.mode, state);
    const dailyUsed = state[cfg.dailyField];

    return {
      ok: true,
      mode: dto.mode,
      costs: { coins: cfg.costCoins, stars: cfg.costStars },
      chances,
      pity: { before: pityBefore },
      limits: {
        dailyUsed,
        dailyLimit: cfg.dailyLimit,
        canUse: dailyUsed < cfg.dailyLimit,
      },
      canAfford:
        user.coins >= cfg.costCoins && user.stars >= cfg.costStars,
    };
  }

  async execute(authHeader: string, dto: SummonPreviewDto) {
    const userId = this.getUserId(authHeader);
    if (!dto.mode) throw new BadRequestException('mode is required');

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true, stars: true },
      });
      if (!user) throw new UnauthorizedException('User not found');

      const state = await this.getSummonState(userId, tx);
      const { cfg, pityBefore, chances } = this.applyPity(dto.mode, state);
      const dailyUsed = state[cfg.dailyField];

      if (dailyUsed >= cfg.dailyLimit) {
        throw new ForbiddenException('Daily summon limit reached');
      }

      if (user.coins < cfg.costCoins || user.stars < cfg.costStars) {
        throw new ForbiddenException('Not enough currency');
      }

      // charge user
      await tx.user.update({
        where: { id: userId },
        data: {
          coins: { decrement: cfg.costCoins },
          stars: { decrement: cfg.costStars },
        },
      });

      const rngRoll = Math.random();
      const rarity = this.pickRarity(chances);
      const resultMonsterId = await this.getRandomMonsterByRarity(rarity, tx);

      await tx.userMonster.upsert({
        where: { userId_monsterId: { userId, monsterId: resultMonsterId } },
        create: { userId, monsterId: resultMonsterId, count: 1 },
        update: { count: { increment: 1 } },
      });

      const isHighRarity = rarity === 'EPIC' || rarity === 'LEGENDARY';
      const pityAfter = isHighRarity ? 0 : pityBefore + 1;

      const client2 = tx as any;
      await client2.userSummonState.update({
        where: { userId },
        data: {
          [cfg.pityField]: pityAfter,
          [cfg.dailyField]: { increment: 1 },
        },
      });

      const log = await client2.summonLog.create({
        data: {
          userId,
          mode: dto.mode,
          resultMonsterId,
          spentCoins: cfg.costCoins,
          spentStars: cfg.costStars,
          rngRoll,
          pityBefore,
          pityAfter,
        },
      });

      return {
        ok: true,
        logId: log.id,
        resultMonsterId,
        rarity,
        pityBefore,
        pityAfter,
      };
    });
  }
}

