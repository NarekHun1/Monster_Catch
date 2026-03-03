import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { MonsterRarity, Prisma } from '@prisma/client';

type FusionMode = 'STANDARD' | 'CATALYST' | 'PREMIUM';

interface FusionPreviewDto {
  mode: FusionMode;
  userMonsterIds: number[];
  tokenId?: number | null;
  useProtection?: boolean;
}

@Injectable()
export class FusionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  private getUserId(authHeader: string): number {
    return this.auth.getUserIdFromToken(authHeader);
  }

  private todayResetAt() {
    // next UTC midnight
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  }

  private async getFusionState(
    userId: number,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ) {
    let state = await tx.userFusionState.findUnique({ where: { userId } });
    const now = new Date();

    if (!state) {
      state = await tx.userFusionState.create({
        data: {
          userId,
          pityStandard: 0,
          pityPremium: 0,
          dailyFusions: 0,
          dailyPremiumFusions: 0,
          resetAt: this.todayResetAt(),
        },
      });
    } else if (state.resetAt <= now) {
      state = await tx.userFusionState.update({
        where: { userId },
        data: {
          dailyFusions: 0,
          dailyPremiumFusions: 0,
          resetAt: this.todayResetAt(),
        },
      });
    }

    return state;
  }

  private getModeConfig(mode: FusionMode) {
    if (mode === 'STANDARD') {
      return {
        costCoins: 100,
        costStars: 0,
        pityField: 'pityStandard' as const,
        pityThreshold: 20,
        dailyLimitField: 'dailyFusions' as const,
        dailyLimit: 200,
        baseChances: {
          COMMON: 0.6,
          RARE: 0.3,
          EPIC: 0.09,
          LEGENDARY: 0.01,
        },
      };
    }
    if (mode === 'CATALYST') {
      return {
        costCoins: 50,
        costStars: 5,
        pityField: 'pityStandard' as const,
        pityThreshold: 15,
        dailyLimitField: 'dailyFusions' as const,
        dailyLimit: 200,
        baseChances: {
          COMMON: 0.4,
          RARE: 0.35,
          EPIC: 0.2,
          LEGENDARY: 0.05,
        },
      };
    }
    // PREMIUM
    return {
      costCoins: 0,
      costStars: 15,
      pityField: 'pityPremium' as const,
      pityThreshold: 10,
      dailyLimitField: 'dailyPremiumFusions' as const,
      dailyLimit: 100,
      baseChances: {
        COMMON: 0.2,
        RARE: 0.4,
        EPIC: 0.3,
        LEGENDARY: 0.1,
      },
    };
  }

  private applyPity(
    mode: FusionMode,
    state: Awaited<ReturnType<FusionService['getFusionState']>>,
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

  async getTokens(authHeader: string) {
    const userId = this.getUserId(authHeader);
    const now = new Date();

    const tokens = await this.prisma.fusionToken.findMany({
      where: {
        userId,
        usedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ok: true,
      tokens,
    };
  }

  async preview(authHeader: string, dto: FusionPreviewDto) {
    const userId = this.getUserId(authHeader);
    if (!dto.mode) throw new BadRequestException('mode is required');
    if (!dto.userMonsterIds?.length)
      throw new BadRequestException('userMonsterIds required');

    const [user, state, protectionToken] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { coins: true, stars: true },
      }),
      this.getFusionState(userId),
      this.prisma.fusionToken.findFirst({
        where: {
          userId,
          kind: 'PROTECTION',
          usedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { id: true },
      }),
    ]);

    if (!user) throw new UnauthorizedException('User not found');

    const { cfg, pityBefore, chances } = this.applyPity(dto.mode, state);

    const dailyUsed = state[cfg.dailyLimitField];
    const canAfford =
      user.coins >= cfg.costCoins && user.stars >= cfg.costStars;

    return {
      ok: true,
      mode: dto.mode,
      costs: { coins: cfg.costCoins, stars: cfg.costStars },
      chances,
      pity: {
        before: pityBefore,
        threshold: cfg.pityThreshold,
      },
      limits: {
        dailyUsed,
        dailyLimit: cfg.dailyLimit,
        canUse: dailyUsed < cfg.dailyLimit,
      },
      protectionAvailable: !!protectionToken,
      canAfford,
    };
  }

  async execute(authHeader: string, dto: FusionPreviewDto) {
    const userId = this.getUserId(authHeader);
    if (!dto.mode) throw new BadRequestException('mode is required');
    if (!dto.userMonsterIds?.length)
      throw new BadRequestException('userMonsterIds required');

    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { coins: true, stars: true },
      });
      if (!user) throw new UnauthorizedException('User not found');

      const state = await this.getFusionState(userId, tx);
      const { cfg, pityBefore, chances } = this.applyPity(dto.mode, state);

      const dailyUsed = state[cfg.dailyLimitField];
      if (dailyUsed >= cfg.dailyLimit) {
        throw new ForbiddenException('Daily fusion limit reached');
      }

      if (user.coins < cfg.costCoins || user.stars < cfg.costStars) {
        throw new ForbiddenException('Not enough currency');
      }

      // validate monsters ownership and availability
      const monsters = await tx.userMonster.findMany({
        where: { id: { in: dto.userMonsterIds }, userId },
        select: { id: true, count: true },
      });
      if (monsters.length !== dto.userMonsterIds.length) {
        throw new BadRequestException('Some monsters not found or not yours');
      }
      if (monsters.some((m) => m.count <= 0)) {
        throw new BadRequestException('You have 0 of some monsters');
      }

      // ensure not in farm, market, hunt
      const inFarm = await tx.farmSlot.findFirst({
        where: {
          userId,
          userMonsterId: { in: dto.userMonsterIds },
          isUnlocked: true,
        },
        select: { id: true },
      });
      if (inFarm) {
        throw new ForbiddenException('Monster is on farm');
      }

      const inMarket = await tx.marketListing.findFirst({
        where: {
          userMonsterId: { in: dto.userMonsterIds },
          status: 'ACTIVE',
        },
        select: { id: true },
      });
      if (inMarket) {
        throw new ForbiddenException('Monster is on market');
      }

      const inHunt = await tx.monsterHunt.findFirst({
        where: { userMonsterId: { in: dto.userMonsterIds }, status: 'RUNNING' },
        select: { endsAt: true },
      });
      if (inHunt && inHunt.endsAt.getTime() > now.getTime()) {
        throw new ForbiddenException('Monster is on hunt');
      }

      // optional protection token
      let protectionToken: { id: number } | null = null;
      if (dto.useProtection) {
        protectionToken = await tx.fusionToken.findFirst({
          where: {
            userId,
            kind: 'PROTECTION',
            usedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          select: { id: true },
        });
        if (!protectionToken) {
          throw new BadRequestException('No protection token');
        }
      }

      // charge costs
      await tx.user.update({
        where: { id: userId },
        data: {
          coins: { decrement: cfg.costCoins },
          stars: { decrement: cfg.costStars },
        },
      });

      // consume monsters (1 each)
      const updated = await tx.userMonster.updateMany({
        where: { id: { in: dto.userMonsterIds }, userId, count: { gte: 1 } },
        data: { count: { decrement: 1 } },
      });
      if (updated.count !== dto.userMonsterIds.length) {
        throw new BadRequestException('Failed to consume monsters');
      }

      // consume protection token if any
      if (protectionToken) {
        await tx.fusionToken.update({
          where: { id: protectionToken.id },
          data: { usedAt: now },
        });
      }

      // roll result
      const rngRoll = Math.random();
      const rarity = this.pickRarity(chances);
      const resultMonsterId = await this.getRandomMonsterByRarity(rarity, tx);

      // grant result monster
      await tx.userMonster.upsert({
        where: { userId_monsterId: { userId, monsterId: resultMonsterId } },
        create: { userId, monsterId: resultMonsterId, count: 1 },
        update: { count: { increment: 1 } },
      });

      const isHighRarity = rarity === 'EPIC' || rarity === 'LEGENDARY';
      const pityAfter = isHighRarity ? 0 : pityBefore + 1;

      // update fusion state
      await tx.userFusionState.update({
        where: { userId },
        data: {
          [cfg.pityField]: pityAfter,
          [cfg.dailyLimitField]: { increment: 1 },
        },
      });

      const log = await tx.fusionLog.create({
        data: {
          userId,
          mode: dto.mode,
          inputsJson: dto.userMonsterIds,
          tokenId: protectionToken?.id ?? null,
          resultMonsterId,
          spentCoins: cfg.costCoins,
          spentStars: cfg.costStars,
          usedProtection: !!protectionToken,
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

