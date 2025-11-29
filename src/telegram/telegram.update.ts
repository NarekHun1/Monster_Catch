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

  // ───────────────────────────────────────────────
  // 1️⃣ START: открыть WebApp
  // ───────────────────────────────────────────────
  @Start()
  async onStart(@Ctx() ctx: Context) {
    const baseUrl =
      this.config.get<string>('WEBAPP_URL') ||
      'https://monster-catch-front.vercel.app';

    await ctx.reply('Открыть игру 👇', {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🎮 Играть',
              web_app: { url: baseUrl },
            },
          ],
        ],
      },
    });
  }

  // ───────────────────────────────────────────────
  // 2️⃣ WebAppQuery → здесь приходят данные из мини-игры
  // ───────────────────────────────────────────────
  @On('web_app_data')
  async onWebAppData(@Ctx() ctx: any) {
    const message = ctx.update?.message;
    const queryId = message?.web_app_data?.query_id;
    const raw = message?.web_app_data?.data;

    // Если это не web_app_query — игнор
    if (!queryId || !raw) return;

    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return ctx.answerWebAppQuery({
        type: 'article',
        id: queryId,
        title: 'Ошибка JSON',
        input_message_content: {
          message_text: '❌ Ошибка: WebApp отправил неверные данные',
        },
      });
    }

    // Обработка покупки монет
    if (data.action === 'buy_coins') {
      return this.processBuyCoins(ctx, queryId, data.packId);
    }
  }

  // ───────────────────────────────────────────────
  // 3️⃣ Создание invoice → возвращается в Mini App
  // ───────────────────────────────────────────────
  async processBuyCoins(ctx: any, queryId: string, packId: string) {
    const packs = {
      coins_500: { starsPrice: 100, coins: 500 },
      coins_1000: { starsPrice: 180, coins: 1000 },
      coins_2500: { starsPrice: 400, coins: 2500 },
    };

    const pack = packs[packId];
    if (!pack) {
      return ctx.answerWebAppQuery({
        type: 'article',
        id: queryId,
        title: 'Ошибка',
        input_message_content: {
          message_text: '❌ Неизвестный пакет',
        },
      });
    }

    // Создаём invoice ссылку
    const invoiceLink = await ctx.telegram.createInvoiceLink({
      title: `${pack.coins} монет`,
      description: `Покупка ${pack.coins} монет`,
      payload: `buy_${packId}`,
      provider_token: '', // Stars = пустая строка
      currency: 'XTR',
      prices: [{ label: 'Монеты', amount: pack.starsPrice }],
    });

    // 🔥 Возвращаем в WebApp → не выходя в чат
    return ctx.answerWebAppQuery({
      type: 'article',
      id: queryId,
      title: 'Покупка',
      input_message_content: {
        message_text: JSON.stringify({
          type: 'invoice',
          link: invoiceLink,
        }),
      },
    });
  }

  // ───────────────────────────────────────────────
  // 4️⃣ Успешная оплата Stars
  // ───────────────────────────────────────────────
  @On('successful_payment')
  async onSuccess(@Ctx() ctx: any) {
    const payment = ctx.message.successful_payment;

    const payload = payment.invoice_payload; // buy_coins_XXX
    const packId = payload.replace('buy_', '');

    const coinsMap = {
      coins_500: 500,
      coins_1000: 1000,
      coins_2500: 2500,
    };

    const coins = coinsMap[packId];
    if (!coins) return;

    const user = await this.users.findByTelegramId(String(ctx.from.id));
    if (!user) return;

    // Сохранить платеж
    await this.payments.registerPayment({
      telegramPaymentChargeId: payment.telegram_payment_charge_id,
      starsAmount: payment.total_amount,
      coinsAmount: coins,
      userTelegramId: String(ctx.from.id),
      payload,
    });

    await ctx.reply(`🎉 Успех! Ты получил +${coins} монет 🪙`);
  }
}
