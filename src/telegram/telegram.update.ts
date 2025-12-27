import { Ctx, Start, Update, On } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { ConfigService } from '@nestjs/config';
import { UserService } from '../user/user.service';
import { PaymentService } from '../payments/payment.service';

@Update()
export class TelegramUpdate {
  constructor(
    private readonly users: UserService,
    private readonly payments: PaymentService,
    private readonly config: ConfigService,
  ) {}

  // ───────────────────────────────
  // START → welcome + referral
  // ───────────────────────────────
  @Start()
  async onStart(@Ctx() ctx: Context) {
    const tgUser = ctx.from;
    if (!tgUser) return;

    // 1️⃣ Upsert пользователя из Telegram
    const user = await this.users.upsertFromTelegram({
      id: tgUser.id,
      username: tgUser.username,
      first_name: tgUser.first_name,
    });

    // 2️⃣ Безопасно читаем payload (/start ref_xxx)
    let payload: string | undefined;

    if (
      ctx.message &&
      'text' in ctx.message &&
      typeof ctx.message.text === 'string'
    ) {
      payload = ctx.message.text.split(' ')[1]; // ref_xxx
    }

    // 3️⃣ Регистрируем реферал
    if (payload?.startsWith('ref_')) {
      const inviterTelegramId = payload.replace('ref_', '');

      await this.users.registerReferralByTelegramId(inviterTelegramId, user.id);
    }

    // 4️⃣ Welcome сообщение (БЕЗ ИЗМЕНЕНИЙ)
    const url =
      this.config.get('WEBAPP_URL') || 'https://monster-catch-front.vercel.app';

    const text = `
👾 *Добро пожаловать в MONSTER CATCH\\!*

Лови монстров, прокачивайся  
и участвуй в турнирах за реальные призы 💎

━━━━━━━━━━━━━━━
🎮 *Как участвовать*

⭐️ *ИГРАЙ БЕСПЛАТНО*
— Лови монстров  
— Зарабатывай ⭐ звёзды  
— Покупай билет в турнир  

💳 *УСКОРЬ ПРОГРЕСС*
— Покупай игровые 🪙 коины  
— Используй коины для билетов  
— Участвуй в турнирах быстрее  

━━━━━━━━━━━━━━━
🏆 *ТУРНИРЫ*
— Соревнуйся с игроками  
— Попади в топ рейтинга  
— Получай награды в *TON 💎*

⚠️ *Важно:*  
Победа зависит от навыков и активности,  
а не от покупки коинов\\.
`;

    await ctx.reply(text, {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [[{ text: '🎮 Играть', web_app: { url } }]],
      },
    });
  }

  // ───────────────────────────────
  // pre_checkout_query
  // ───────────────────────────────
  @On('pre_checkout_query')
  async onPreCheckout(@Ctx() ctx: any) {
    await ctx.answerPreCheckoutQuery(true);
  }

  // ───────────────────────────────
  // successful_payment
  // ───────────────────────────────
  @On('successful_payment')
  async onSuccess(@Ctx() ctx: any) {
    const payment = ctx.message.successful_payment;
    const telegramId = String(ctx.from.id);

    const packId = payment.invoice_payload.replace('buy_', '');

    const packs = {
      coins_500: 100,
      coins_1000: 150,
      coins_2500: 300,
    };

    const coins = packs[packId];
    if (!coins) return ctx.reply('Ошибка товара ❌');

    await this.payments.registerPayment({
      telegramPaymentChargeId: payment.telegram_payment_charge_id,
      starsAmount: payment.total_amount,
      coinsAmount: coins,
      userTelegramId: telegramId,
      payload: payment.invoice_payload,
    });

    await ctx.reply(`🎉 Успешно! +${coins} монет 🪙`);
  }
}
