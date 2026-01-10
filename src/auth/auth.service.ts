import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { verifyTelegramInitData } from './verifyTelegram';
import { ConfigService } from '@nestjs/config';
import { User } from '@prisma/client';
import * as jwt from 'jsonwebtoken';

interface JwtPayload {
  userId: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ─────────────────────────────────────────────
  // TELEGRAM LOGIN
  // ─────────────────────────────────────────────
  async login(initData: string): Promise<{ token: string; user: User }> {
    const botToken = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');

    const ok = verifyTelegramInitData(initData, botToken);
    if (!ok) {
      throw new UnauthorizedException('Invalid Telegram initData');
    }

    const params = new URLSearchParams(initData);
    const rawUser = params.get('user');
    if (!rawUser) {
      throw new UnauthorizedException('Missing user');
    }

    const tgUser = JSON.parse(rawUser);

    const user = await this.prisma.user.upsert({
      where: { telegramId: tgUser.id.toString() },
      update: {
        username: tgUser.username ?? undefined,
        firstName: tgUser.first_name ?? undefined,
        lastSeenAt: new Date(),
      },
      create: {
        telegramId: tgUser.id.toString(),
        username: tgUser.username ?? undefined,
        firstName: tgUser.first_name ?? undefined,
      },
    });

    const jwtSecret = this.config.getOrThrow<string>('JWT_SECRET');

    const token = jwt.sign({ userId: user.id }, jwtSecret, { expiresIn: '7d' });

    return { token, user };
  }

  // ─────────────────────────────────────────────
  // JWT PARSE
  // ─────────────────────────────────────────────
  getUserIdFromToken(authHeader: string): number {
    if (!authHeader) {
      throw new UnauthorizedException('TOKEN_MISSING');
    }

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret) {
      throw new UnauthorizedException('JWT_SECRET missing');
    }

    // ✅ ОБРЕЗАЕМ Bearer
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    try {
      const payload = jwt.verify(token, secret) as JwtPayload;

      if (!payload.userId) {
        throw new UnauthorizedException('INVALID_PAYLOAD');
      }

      return payload.userId;
    } catch (err: any) {
      console.warn('JWT VERIFY ERROR:', err?.name, err?.message);

      if (err?.name === 'TokenExpiredError') {
        throw new UnauthorizedException('TOKEN_EXPIRED');
      }

      throw new UnauthorizedException('INVALID_TOKEN');
    }
  }
}
