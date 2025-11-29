import { Ctx, Start, Update, On } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { UserService } from '../user/user.service';
import { PaymentService } from '../payments/payment.service';
import { ConfigService } from '@nestjs/config';

@Update()
export class TelegramUpdate {
  constructor(
    private readonly users: UserService,
    private readonly payments: PaymentService,
    private readonly config: ConfigService,
  ) {}

  // ───────────────────────────────
  // 1) START: открыть WebApp
  // ───────────────────────────────
  @Start()
  async onStart(@Ctx() ctx: Context) {
    const url =
      this.config.get('WEBAPP_URL') || 'https://monster-catch-front.vercel.app';

    await ctx.reply('Открыть игру 👇', {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🎮 Играть',
              web_app: { url },
            },
          ],
        ],
      },
    });
  }

  // ───────────────────────────────
  // 2) WebAppQuery → покупка монет
  // ───────────────────────────────
  @On('web_app_data')
  async onWebAppQuery(@Ctx() ctx: any) {
    const queryId = ctx.update?.message?.web_app_data?.query_id;
    const raw = ctx.update?.message?.web_app_data?.data;

    if (!queryId || !raw) return;

    let data: any;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return ctx.answerWebAppQuery({
        type: 'article',
        id: queryId,
        title: 'Ошибка',
        input_message_content: {
          message_text: 'Ошибка JSON',
        },
      });
    }

    if (data.action === 'buy_coins') {
      return this.processBuyCoins(ctx, queryId, data.packId);
    }
  }

  // ───────────────────────────────
  // 3) Создание invoice
  // ───────────────────────────────
  async processBuyCoins(ctx: any, queryId: string, packId: string) {
    const packs = {
      coins_500: { starsPrice: 100, coins: 500 },
      coins_1000: { starsPrice: 180, coins: 1000 },
      coins_2500: { starsPrice: 400, coins: 2500 },
    };

    const pack = packs[packId];
    if (!pack) return;

    const link = await ctx.telegram.createInvoiceLink({
      title: `${pack.coins} монет`,
      description: `Покупка ${pack.coins} монет`,
      payload: `buy_${packId}`,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Монеты', amount: pack.starsPrice }],
    });

    // 🔥 ВОТ ЭТО И ЕСТЬ ГЛАВНЫЙ МОМЕНТ:
    // Mini App получает ответ БЕЗ выхода в чат
    await ctx.answerWebAppQuery({
      type: 'article',
      id: queryId,
      title: 'invoice',
      input_message_content: {
        message_text: JSON.stringify({
          type: 'invoice',
          link,
        }),
      },
    });
  }

  // ───────────────────────────────
  // 4) Успешная оплата
  // ───────────────────────────────
  @On('successful_payment')
  async onSuccess(@Ctx() ctx: any) {
    const p = ctx.message.successful_payment;

    const packId = p.invoice_payload.replace('buy_', '');
    const coins = {
      coins_500: 500,
      coins_1000: 1000,
      coins_2500: 2500,
    }[packId];

    if (!coins) return;

    const user = await this.users.findByTelegramId(String(ctx.from.id));
    if (!user) return;

    await this.payments.registerPayment({
      telegramPaymentChargeId: p.telegram_payment_charge_id,
      starsAmount: p.total_amount,
      coinsAmount: coins,
      userTelegramId: String(ctx.from.id),
      payload: p.invoice_payload,
    });

    await ctx.reply(`🎉 Покупка успешна! +${coins} монет`);
  }
}
