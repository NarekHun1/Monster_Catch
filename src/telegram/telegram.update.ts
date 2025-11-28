import { Ctx, Start, Update, On } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { UserService } from '../user/user.service';
import { ConfigService } from '@nestjs/config';

@Update()
export class TelegramUpdate {
  constructor(
    private readonly userService: UserService,
    private readonly config: ConfigService,
  ) {
    console.log('TelegramUpdate initialized');
  }

  // ────────────────────────────────────────────────
  // 1️⃣ START — открытие WebApp
  // ────────────────────────────────────────────────
  @Start()
  async onStart(@Ctx() ctx: Context) {
    console.log('onStart from:', ctx.from);

    const startPayload = (ctx as any).startPayload as string | undefined;
    const from = ctx.from;

    if (!from) {
      await ctx.reply('Не могу определить пользователя.');
      return;
    }

    // Создаём/обновляем пользователя
    const user = await this.userService.upsertFromTelegram({
      id: from.id,
      username: from.username,
      first_name: from.first_name,
    });

    // РЕФЕРАЛКА
    if (startPayload?.startsWith('ref_')) {
      const inviterId = startPayload.replace('ref_', '');
      if (String(from.id) !== inviterId) {
        await this.userService.registerReferralByTelegramId(inviterId, user.id);
      }
    }

    // WebApp URL из .env
    const baseUrl =
      this.config.get<string>('WEBAPP_URL') ||
      'https://monster-catch-front.vercel.app';

    const botUsername =
      this.config.get<string>('TELEGRAM_BOT_NAME') ||
      (ctx as any).botInfo?.username;

    const refLink = `https://t.me/${botUsername}?start=ref_${from.id}`;

    // Кнопка "Играть"
    await ctx.reply('Нажми кнопку, чтобы открыть игру 👇', {
      reply_markup: {
        keyboard: [
          [
            {
              text: '🎮 Играть',
              web_app: { url: baseUrl },
            },
          ],
        ],
        resize_keyboard: true,
      },
    });

    await ctx.reply(
      `Твоя реферальная ссылка:\n${refLink}\n\nПриглашай друзей и получай награды ⭐`,
    );
  }

  // ────────────────────────────────────────────────
  // 2️⃣ WebApp sendData()
  // ────────────────────────────────────────────────
  @On('message')
  async onWebAppMessage(@Ctx() ctx: any) {
    const raw = ctx?.webAppData?.data;
    if (!raw) return;

    console.log('📩 WebApp DATA:', raw);

    let data: any;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.log('❌ JSON parse error:', e);
      return;
    }

    // Купить монеты
    if (data.action === 'buy_coins') {
      return this.handleBuyCoins(ctx, data.packId);
    }
  }

  // ────────────────────────────────────────────────
  // 3️⃣ Отправка invoice Stars
  // ────────────────────────────────────────────────
  async handleBuyCoins(ctx: Context, packId: string) {
    console.log('💳 Покупка монет:', packId);

    const packs = {
      coins_500: {
        starsPrice: 100,
        coins: 500,
        title: '500 монет',
        description: 'Пакет 500 монет для игры',
      },
      coins_1000: {
        starsPrice: 180,
        coins: 1000,
        title: '1000 монет',
        description: 'Пакет 1000 монет для игры',
      },
    };

    const pack = packs[packId as keyof typeof packs];
    if (!pack) return ctx.reply('Неизвестный пакет ❌');

    await ctx.replyWithInvoice({
      title: pack.title,
      description: pack.description,
      payload: `buy_coins_${packId}`,
      provider_token: '', // ⭐ Для Stars ВСЕГДА пустой
      currency: 'XTR',
      prices: [
        {
          label: pack.title,
          amount: pack.starsPrice,
        },
      ],
    });

    console.log(`📨 Invoice отправлен!`);
  }

  // ────────────────────────────────────────────────
  // 4️⃣ Подтверждение оплаты Stars
  // ────────────────────────────────────────────────
  @On('pre_checkout_query')
  async onPreCheckout(@Ctx() ctx: any) {
    console.log('⚙️ pre_checkout_query received');
    await ctx.answerPreCheckoutQuery(true);
  }

  // ────────────────────────────────────────────────
  // 5️⃣ Успешный платеж Stars
  // ────────────────────────────────────────────────
  @On('successful_payment')
  async onSuccess(@Ctx() ctx: any) {
    const payment = ctx.message.successful_payment;

    console.log('🎉 SUCCESSFUL PAYMENT:', payment);

    const payload = payment.invoice_payload; // buy_coins_coins_500
    const packId = payload.replace('buy_coins_', '');

    const packs = {
      coins_500: { coins: 500 },
      coins_1000: { coins: 1000 },
    };

    const pack = packs[packId as keyof typeof packs];
    if (!pack) {
      return ctx.reply('Ошибка: товар не найден ❌');
    }

    const telegramId = String(ctx.from.id);
    const user = await this.userService.findByTelegramId(telegramId);

    if (!user) {
      return ctx.reply('Ошибка: пользователь не найден ❌');
    }

    await this.userService.addCoins(user.id, pack.coins);

    await ctx.reply(
      `🎉 Покупка успешна!\nТебе начислено: +${pack.coins} монет 🪙`,
    );

    console.log(`💰 ${telegramId}: +${pack.coins} монет`);
  }
}
