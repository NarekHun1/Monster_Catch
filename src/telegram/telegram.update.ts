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

  // -----------------------------
  // START → открыть WebApp
  // -----------------------------
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

  // -----------------------------
  // WebApp → sendData()
  // -----------------------------
  @On('message')
  async onWebAppMessage(@Ctx() ctx: any) {
    const raw = ctx?.update?.message?.web_app_data?.data;

    if (!raw) {
      console.log('❌ web_app_data отсутствует, обычное сообщение');
      return;
    }

    console.log('📩 WebApp RAW DATA:', raw);

    let data: any;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.log('❌ JSON parse error:', e);
      return ctx.reply('Ошибка при чтении данных WebApp ❌');
    }

    console.log('📦 Parsed DATA:', data);

    if (data.action === 'buy_coins') {
      return this.handleBuyCoins(ctx, data.packId);
    }
  }

  // -----------------------------
  // Invoice Stars
  // -----------------------------
  async handleBuyCoins(ctx: Context, packId: string) {
    const packs = {
      coins_500: { starsPrice: 100, coins: 500 },
      coins_1000: { starsPrice: 180, coins: 1000 },
      coins_2500: { starsPrice: 400, coins: 2500 },
    };

    const pack = packs[packId];
    if (!pack) return ctx.reply('Неизвестный пакет');

    // создаём invoice link
    const link = await ctx.telegram.createInvoiceLink({
      title: `Покупка ${pack.coins} монет`,
      description: `Пополнение баланса на ${pack.coins} монет`,
      payload: `buy_${packId}`,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: `${pack.coins} монет`, amount: pack.starsPrice }],
    });

    // отправляем в WebApp
    await ctx.reply(`{"invoiceLink":"${link}"}`);
  }

  // -----------------------------
  // Pre-checkout
  // -----------------------------
  @On('pre_checkout_query')
  async onPreCheckout(@Ctx() ctx: any) {
    await ctx.answerPreCheckoutQuery(true);
  }

  // -----------------------------
  // Успешная оплата
  // -----------------------------
  @On('successful_payment')
  async onSuccess(@Ctx() ctx: any) {
    const p = ctx.message.successful_payment;
    const telegramId = String(ctx.from.id);

    const packId = p.invoice_payload.replace('buy_', '');

    const packs = {
      coins_500: 500,
      coins_1000: 1000,
      coins_2500: 2500,
    };

    const coins = packs[packId];
    if (!coins) return ctx.reply('Ошибка товара ❌');

    await this.payments.registerPayment({
      telegramPaymentChargeId: p.telegram_payment_charge_id,
      starsAmount: p.total_amount,
      coinsAmount: coins,
      userTelegramId: telegramId,
      payload: p.invoice_payload,
    });

    await ctx.reply(`🎉 Успешно!\nНачислено +${coins} монет 🪙`);
  }
}
