// src/referral/referral.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ReferralService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getReferralLinkForUser(userId: number) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // username бота из .env
    const botName =
      this.config.get<string>('TELEGRAM_BOT_USERNAME') ?? 'monster_catch_bot';

    const link = `https://t.me/${botName}?start=ref_${user.telegramId}`;

    return { link };
  }
}
