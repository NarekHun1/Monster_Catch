// telegram-webapp.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { UserService } from '../user/user.service';
import * as jwt from 'jsonwebtoken';

@Controller('telegram')
export class TelegramWebappController {
  constructor(
    private readonly config: ConfigService,
    private readonly userService: UserService,
  ) {}

  @Post('webapp-auth')
  async webappAuth(@Body() body: { initData: string }) {
    const { initData } = body;
    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    const jwtSecret = this.config.get<string>('JWT_SECRET');

    if (!botToken || !jwtSecret) {
      throw new Error('Missing config');
    }

    // 1. Проверяем подпись initData (по докам Telegram WebApp)
    const isValid = this.checkTelegramInitData(initData, botToken);
    if (!isValid) {
      throw new Error('Invalid initData');
    }

    // 2. Парсим данные
    const data = new URLSearchParams(initData);
    const userJson = data.get('user');
    if (!userJson) {
      throw new Error('No user in initData');
    }

    const tgUser = JSON.parse(userJson) as {
      id: number;
      username?: string;
      first_name?: string;
    };

    // 3. Апсертим пользователя
    const user = await this.userService.upsertFromTelegram({
      id: tgUser.id,
      username: tgUser.username,
      first_name: tgUser.first_name,
    });

    // 4. Генерим JWT
    const token = jwt.sign({ userId: user.id }, jwtSecret, {
      expiresIn: '7d',
    });

    return { token };
  }

  private checkTelegramInitData(initData: string, botToken: string): boolean {
    const data = new URLSearchParams(initData);

    const hash = data.get('hash');
    if (!hash) return false;

    data.delete('hash');

    const sorted = [...data.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secret = crypto.createHash('sha256').update(botToken).digest();

    const check = crypto
      .createHmac('sha256', secret)
      .update(sorted)
      .digest('hex');

    return check === hash;
  }
}
