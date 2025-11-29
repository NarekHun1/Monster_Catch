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

  // ---------------------------------------------
  // 1) START — запуск мини-игры
  // ---------------------------------------------
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

  // ---------------------------------------------
  // 2) WebAppQuery — данные из мини-игры
  // ---------------------------------------------
  @On('web_app_data')
  async onWebAppQuery(@Ctx() ctx: any) {
    const msg = ctx.update?.message;

    if (!msg?.web_app_data) return;

    const queryId = msg.web_app_data.query_id;
    const raw = msg.web_app_data.data;

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
          message_text: '❌ Ошибка JSON',
        },
      });
    }

    if (data.action === 'buy_coins') {
      return this.processBuyCoins(ctx, queryId, data.packId);
    }
  }

  // ---------------------------------------------
  // 3) Создание invoice для Stars
  // ---------------------------------------------
  async processBuyCoins(ctx: any, queryId: string, packId: string) {
    const packs = {
      coins_500: { starsPrice: 100, coins: 500 },
      coins_1000: { starsPrice: 180, coins: 1000 },
      coins_2500: { starsPrice: 400, coins: 2500 },
    };

    const pack = packs[packId];
    if (!pack) return;

    // ссылка на оплату Stars
    const link = await ctx.telegram.createInvoiceLink({
      title: `${pack.coins} монет`,
      description: `Покупка ${pack.coins} монет`,
      payload: `buy_${packId}`,
      provider_token: '', // Stars → пусто
      currency: 'XTR',
      prices: [{ label: 'Монеты', amount: pack.starsPrice }],
    });

    // Главный момент: отправка ответа прямо в WebApp
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

  // ---------------------------------------------
  // 4) Успешный платёж Stars
  // ---------------------------------------------
  @On('successful_payment')
  async onSuccess(@Ctx() ctx: any) {
    const pay = ctx.message.successful_payment;
    const payload = pay.invoice_payload;

    const packId = payload.replace('buy_', '');

    const coinsTable: any = {
      coins_500: 500,
      coins_1000: 1000,
      coins_2500: 2500,
    };

    const coins = coinsTable[packId];
    if (!coins) return;

    // ищем пользователя
    const user = await this.users.findByTelegramId(String(ctx.from.id));
    if (!user) return;

    // сохраняем платёж
    await this.payments.registerPayment({
      telegramPaymentChargeId: pay.telegram_payment_charge_id,
      starsAmount: pay.total_amount,
      coinsAmount: coins,
      userTelegramId: String(ctx.from.id),
      payload,
    });

    // сообщение в чат (не WebApp)
    await ctx.reply(`🎉 Покупка успешна! Тебе начислено +${coins} монет 🪙`);
  }
}
