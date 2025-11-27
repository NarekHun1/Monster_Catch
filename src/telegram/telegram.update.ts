import { Ctx, Start, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { UserService } from '../user/user.service';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';

@Update()
export class TelegramUpdate {
  constructor(
    private readonly userService: UserService,
    private readonly config: ConfigService,
  ) {
    console.log('TelegramUpdate constructed');
  }

  @Start()
  async onStart(@Ctx() ctx: Context) {
    console.log('onStart triggered, from =', ctx.from);

    const startPayload = (ctx as any).startPayload as string | undefined;
    console.log('startPayload =', startPayload);

    const from = ctx.from;
    if (!from) {
      await ctx.reply('Не могу определить пользователя :(');
      return;
    }

    // создаём / обновляем пользователя
    const user = await this.userService.upsertFromTelegram({
      id: from.id,
      username: from.username,
      first_name: from.first_name,
    });

    // рефералка
    if (startPayload?.startsWith('ref_')) {
      const inviterTelegramIdStr = startPayload.replace('ref_', '');
      console.log('inviterTelegramIdStr =', inviterTelegramIdStr);

      if (inviterTelegramIdStr !== String(from.id)) {
        await this.userService.registerReferralByTelegramId(
          inviterTelegramIdStr,
          user.id,
        );
      }
    }

    // JWT
    const jwtSecret = this.config.get<string>('JWT_SECRET');
    if (!jwtSecret) {
      console.error('JWT_SECRET is not set');
      await ctx.reply('Проблема с конфигурацией сервера :(');
      return;
    }

    const token = jwt.sign({ userId: user.id }, jwtSecret, {
      expiresIn: '7d',
    });

    const baseUrlFromEnv = this.config.get<string>('WEBAPP_URL');
    const baseUrl = baseUrlFromEnv || 'https://monster-catch-front.vercel.app';
    console.log('BOT USERNAME:', (ctx as any).botInfo?.username);
    console.log('WEBAPP_URL from env:', this.config.get('WEBAPP_URL'));

    // 🔥 опять добавляем токен в URL
    const urlWithToken = `${baseUrl}?token=${encodeURIComponent(token)}`;

    const botNameFromConfig = this.config.get<string>('TELEGRAM_BOT_NAME');
    const botUsername =
      botNameFromConfig || (ctx as any).botInfo?.username || '<YOUR_BOT_NAME>';

    const myRefLink = `https://t.me/${botUsername}?start=ref_${from.id}`;

    // кнопка "Играть" снова открывает URL с токеном
    await ctx.reply('Нажми кнопку, чтобы открыть игру 👇', {
      reply_markup: {
        keyboard: [
          [
            {
              text: '🎮 Играть',
              web_app: {
                url: urlWithToken,
              },
            },
          ],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
      },
    });

    await ctx.reply(
      `Твоя ссылка для приглашений:\n${myRefLink}\n\nПриглашай друзей и получай ⭐ за их первую игру!`,
    );
  }
}
