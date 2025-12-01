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

  // ─────────────────────────────
  // START → открыть игру
  // ─────────────────────────────
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

  // ─────────────────────────────
  // ВАЖНО: WebAppQuery приходит
  // внутри message → web_app_data
  // ─────────────────────────────
  @On('message')
  async onMessage(@Ctx() ctx: any) {
    const webAppQuery = ctx.update?.web_app_query;
    const webAppData = ctx.update?.message?.web_app_data;

    // 1) Веб-ап запрос типа sendData()
    if (webAppQuery) {
      return this.handleWebAppQuery(ctx, webAppQuery);
    }

    // 2) Альтернативный способ: sendData() может прийти в message.web_app_data
    if (webAppData?.data) {
      return this.handleWebAppData(ctx, webAppData);
    }
  }

  // обработка web_app_query
  private async handleWebAppQuery(ctx: any, query: any) {
    const queryId = query.id;
    const raw = query.data;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return ctx.answerWebAppQuery({
        type: 'article',
        id: queryId,
        title: 'Ошибка JSON',
        input_message_content: {
          message_text: '❌ WebApp прислал неверный JSON',
        },
      });
    }

    if (data.action === 'buy_coins') {
      return this.processBuyCoins(ctx, queryId, data.packId);
    }
  }

  // обработка message.web_app_data.data
  private async handleWebAppData(ctx: any, webAppData: any) {
    const raw = webAppData.data;
    const messageId = String(Date.now()); // уникальный ID для ответа

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return ctx.reply('❌ WebApp прислал неверные данные');
    }

    if (data.action === 'buy_coins') {
      return this.processBuyCoins(ctx, messageId, data.packId);
    }
  }

  // ─────────────────────────────
  // Создание invoice
  // ─────────────────────────────
  private async processBuyCoins(ctx: any, queryId: string, packId: string) {
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
        input_message_content: { message_text: '❌ Неизвестный пакет' },
      });
    }

    const link = await ctx.telegram.createInvoiceLink({
      title: `${pack.coins} монет`,
      description: `Покупка ${pack.coins} монет`,
      payload: `buy_${packId}`,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'Монеты', amount: pack.starsPrice }],
    });

    return ctx.answerWebAppQuery({
      type: 'article',
      id: queryId,
      title: 'Покупка монет',
      input_message_content: {
        message_text: JSON.stringify({ type: 'invoice', link }),
      },
    });
  }

  // ─────────────────────────────
  // Успешная оплата
  // ─────────────────────────────
  @On('successful_payment')
  async onSuccess(@Ctx() ctx: any) {
    const p = ctx.message.successful_payment;

    const packId = p.invoice_payload.replace('buy_', '');

    const map = {
      coins_500: 500,
      coins_1000: 1000,
      coins_2500: 2500,
    };

    const coins = map[packId];
    if (!coins) return;

    await this.payments.registerPayment({
      telegramPaymentChargeId: p.telegram_payment_charge_id,
      starsAmount: p.total_amount,
      coinsAmount: coins,
      userTelegramId: String(ctx.from.id),
      payload: p.invoice_payload,
    });

    await ctx.reply(`🎉 Успешно! +${coins} монет 🪙`);
  }
}
