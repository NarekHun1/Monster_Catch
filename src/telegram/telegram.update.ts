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
  // 1) START → открыть WebApp
  // ───────────────────────────────
  @Start()
  async onStart(@Ctx() ctx: Context) {
    const url =
      this.config.get('WEBAPP_URL') || 'https://monster-catch-front.vercel.app';

    await ctx.reply('Открыть игру 👇', {
      reply_markup: {
        inline_keyboard: [[{ text: '🎮 Играть', web_app: { url } }]],
      },
    });
  }

  // ───────────────────────────────
  // 2) WebApp sendData()
  // ───────────────────────────────
  @On('message')
  async onWebAppMessage(@Ctx() ctx: any) {
    const raw = ctx?.update?.message?.web_app_data?.data;
    if (!raw) return;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return ctx.reply('Ошибка формата WebApp данных');
    }

    if (data.action === 'buy_coins') {
      return this.handleBuyCoins(ctx, data.packId);
    }
  }

  // ───────────────────────────────
  // 3) создание invoice link
  // ───────────────────────────────
  async handleBuyCoins(ctx: any, packId: string) {
    const packs = {
      coins_500: { starsPrice: 100, coins: 500 },
      coins_1000: { starsPrice: 180, coins: 1000 },
      coins_2500: { starsPrice: 400, coins: 2500 },
    };

    const pack = packs[packId];
    if (!pack) return;

    // создаём invoice link
    const invoiceUrl = await ctx.telegram.createInvoiceLink({
      title: `${pack.coins} монет`,
      description: `Покупка ${pack.coins} монет`,
      payload: `buy_${packId}`,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Монеты', amount: pack.starsPrice }],
    });

    // 🔥 самое главное — отправляем ОБРАТНО в WebApp
    await ctx.webApp.sendData(
      JSON.stringify({
        type: 'invoice',
        link: invoiceUrl,
      }),
    );
  }

  // ───────────────────────────────
  // 4) pre_checkout_query
  // ───────────────────────────────
  @On('pre_checkout_query')
  async onPreCheckout(@Ctx() ctx: any) {
    await ctx.answerPreCheckoutQuery(true);
  }

  // ───────────────────────────────
  // 5) Успешная оплата
  // ───────────────────────────────
  @On('successful_payment')
  async onSuccess(@Ctx() ctx: any) {
    const payment = ctx.message.successful_payment;
    const telegramId = String(ctx.from.id);

    const packId = payment.invoice_payload.replace('buy_', '');

    const packs = {
      coins_500: 500,
      coins_1000: 1000,
      coins_2500: 2500,
    };

    const coins = packs[packId];
    if (!coins) return ctx.reply('Ошибка товара ❌');

    // записываем оплату
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
