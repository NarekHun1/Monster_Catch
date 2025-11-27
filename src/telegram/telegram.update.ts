import { Ctx, Start, Update } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { UserService } from '../user/user.service';
import { ConfigService } from '@nestjs/config';

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

    // 1. payload типа "ref_123456789" (если пришёл по реф-ссылке)
    const startPayload = (ctx as any).startPayload as string | undefined;
    console.log('startPayload =', startPayload);

    const from = ctx.from;
    if (!from) {
      await ctx.reply('Не могу определить пользователя :(');
      return;
    }

    // 2. Создаём/обновляем пользователя в БД по данным телеграма
    const user = await this.userService.upsertFromTelegram({
      id: from.id,
      username: from.username,
      first_name: from.first_name,
    });

    // 3. Если есть реферальный payload — регистрируем реферала
    if (startPayload?.startsWith('ref_')) {
      const inviterTelegramIdStr = startPayload.replace('ref_', '');
      console.log('inviterTelegramIdStr =', inviterTelegramIdStr);

      // не даём человеку пригласить самого себя
      if (inviterTelegramIdStr !== String(from.id)) {
        await this.userService.registerReferralByTelegramId(
          inviterTelegramIdStr,
          user.id, // id из БД
        );
      }
    }

    // 4. Больше НЕ генерим JWT и НЕ пихаем token в URL
    const baseUrlFromEnv = this.config.get<string>('WEBAPP_URL');
    const baseUrl = baseUrlFromEnv || 'https://monster-catch-front.vercel.app';

    console.log('BOT USERNAME:', (ctx as any).botInfo?.username);
    console.log('WEBAPP_URL from env:', this.config.get('WEBAPP_URL'));

    const botNameFromConfig = this.config.get<string>('TELEGRAM_BOT_NAME');
    const botUsername =
      botNameFromConfig || (ctx as any).botInfo?.username || '<YOUR_BOT_NAME>';

    const myRefLink = `https://t.me/${botUsername}?start=ref_${from.id}`;

    // 5. Отправляем кнопку "Играть" БЕЗ токена в URL
    await ctx.reply('Нажми кнопку, чтобы открыть игру 👇', {
      reply_markup: {
        keyboard: [
          [
            {
              text: '🎮 Играть',
              web_app: {
                url: baseUrl, // 🔥 БЕЗ ?token=...
              },
            },
          ],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
      },
    });

    // 6. Реф-ссылка остаётся рабочей
    await ctx.reply(
      `Твоя ссылка для приглашений:\n${myRefLink}\n\nПриглашай друзей и получай ⭐ за их первую игру!`,
    );
  }
}
