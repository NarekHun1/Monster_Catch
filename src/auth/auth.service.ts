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

  async login(initData: string): Promise<{ token: string; user: User }> {
    const botToken = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');

    console.log('--- AUTH /telegram ---');
    console.log('BOT TOKEN starts with:', botToken.slice(0, 10));
    console.log('INIT DATA RAW:', initData);

    const ok = verifyTelegramInitData(initData, botToken);
    console.log('VERIFY RESULT:', ok);

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
    const token = jwt.sign({ userId: user.id }, jwtSecret, {
      expiresIn: '7d',
    });

    return { token, user };
  }
  getUserIdFromToken(token: string): number {
    if (!token) {
      throw new UnauthorizedException('TOKEN_MISSING');
    }

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret) {
      throw new UnauthorizedException('JWT_SECRET missing');
    }

    try {
      const payload = jwt.verify(token, secret) as JwtPayload;

      if (!payload.userId) {
        throw new UnauthorizedException('INVALID_PAYLOAD');
      }

      return payload.userId;
    } catch (err: any) {
      if (err.name === 'TokenExpiredError') {
        throw new UnauthorizedException('TOKEN_EXPIRED');
      }
      throw new UnauthorizedException('INVALID_TOKEN');
    }
  }
}
