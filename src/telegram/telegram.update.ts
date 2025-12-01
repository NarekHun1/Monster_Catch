import { Ctx, Start, Update, On } from 'nestjs-telegraf';
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

  @Start()
  async onStart(@Ctx() ctx: any) {
    const url = this.config.get('WEBAPP_URL');

    await ctx.reply('Открыть игру 👇', {
      reply_markup: {
        inline_keyboard: [[{ text: '🎮 Играть', web_app: { url } }]],
      },
    });
  }

  // ------------------------------------------------------
  // WebApp → sendData() приходит как ctx.update.web_app_query
  // ------------------------------------------------------
  @On('web_app_query')
  async onWebAppQuery(@Ctx() ctx: any) {
    const query = ctx.update.web_app_query;
    if (!query) return;

    console.log("🔥 Получен web_app_query:", query);

    const queryId = query.id;
    const raw = query.data;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return ctx.answerWebAppQuery({
        type: "article",
        id: queryId,
        title: "Ошибка",
        input_message_content: {
          message_text: "❌ JSON ошибка",
        },
      });
    }

    if (data.action === "buy_coins") {
      return this.processBuyCoins(ctx, queryId, data.packId);
    }
  }

  // ------------------------------------------------------
  // Создание INVOICE в мини-игру
  // ------------------------------------------------------
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
        input_message_content: { message_text: "Неизвестный пакет" },
      });
    }

    const link = await ctx.telegram.createInvoiceLink({
      title: `${pack.coins} монет`,
      description: `Покупка ${pack.coins} монет`,
      payload: `buy_${packId}`,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: "Монеты", amount: pack.starsPrice }],
    });

    // 👉 Отправляем ответ в Mini App (НЕ в чат)
    return ctx.answerWebAppQuery({
      type: "article",
      id: queryId,
      title: "invoice",
      input_message_content: {
        message_text: JSON.stringify({
          type: "invoice",
          link,
        }),
      },
    });
  }

  @On('successful_payment')
  async onSuccess(@Ctx() ctx: any) {
    const p = ctx.message.successful_payment;
    const id = String(ctx.from.id);

    const packId = p.invoice_payload.replace("buy_", "");

    const coinsMap = {
      coins_500: 500,
      coins_1000: 1000,
      coins_2500: 2500,
    };

    const coins = coinsMap[packId];
    if (!coins) return;

    await this.payments.registerPayment({
      telegramPaymentChargeId: p.telegram_payment_charge_id,
      starsAmount: p.total_amount,
      coinsAmount: coins,
      userTelegramId: id,
      payload: p.invoice_payload,
    });

    await ctx.reply(`🎉 Успешно! +${coins} монет`);
  }
}
