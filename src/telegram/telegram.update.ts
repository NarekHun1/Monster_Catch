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

  // ------------------------------------------
  // 1) START → кнопка открыть Mini App
  // ------------------------------------------
  @Start()
  async onStart(@Ctx() ctx: Context) {
    const url =
      this.config.get<string>('WEBAPP_URL') ||
      'https://monster-catch-front.vercel.app';

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

  // ------------------------------------------
  // 2) WebApp Query → событие sendData()
  // ------------------------------------------
  @On('web_app_query' as any)
  async onWebAppQuery(@Ctx() ctx: any) {
    const query = ctx.update?.web_app_query;

    console.log("🔥 web_app_query:", query);

    if (!query) return;

    const queryId = query.id;
    const raw = query.data;

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      return ctx.answerWebAppQuery({
        type: 'article',
        id: queryId,
        title: 'Ошибка JSON',
        input_message_content: {
          message_text: '❌ Неверный формат данных',
        },
      });
    }

    if (data.action === 'buy_coins') {
      return this.processBuyCoins(ctx, queryId, data.packId);
    }
  }

  // ------------------------------------------
  // 3) Создание invoice → Mini App откроет оплату
  // ------------------------------------------
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

    // Создаём invoice link
    const invoice = await ctx.telegram.createInvoiceLink({
      title: `${pack.coins} монет`,
      description: `Покупка ${pack.coins} монет`,
      payload: `buy_${packId}`,
      provider_token: '', // Stars → пустой
      currency: 'XTR',
      prices: [{ label: 'Монеты', amount: pack.starsPrice }],
    });

    // Возвращаем обратно в Mini App
    return ctx.answerWebAppQuery({
      type: 'article',
      id: queryId,
      title: 'Покупка монет',
      input_message_content: {
        message_text: JSON.stringify({
          type: 'invoice',
          link: invoice,
        }),
      },
    });
  }

  // ------------------------------------------
  // 4) Успешная оплата
  // ------------------------------------------
  @On('successful_payment')
  async onSuccess(@Ctx() ctx: any) {
    const p = ctx.message.successful_payment;

    const packId = p.invoice_payload.replace('buy_', '');

    const coinsMap = {
      coins_500: 500,
      coins_1000: 1000,
      coins_2500: 2500,
    };

    const coins = coinsMap[packId];
    if (!coins) return;

    const user = await this.users.findByTelegramId(String(ctx.from.id));
    if (!user) return;

    await this.payments.registerPayment({
      telegramPaymentChargeId: p.telegram_payment_charge_id,
      starsAmount: p.total_amount,
      coinsAmount: coins,
      payload: p.invoice_payload,
      userTelegramId: String(ctx.from.id),
    });

    await ctx.reply(`🎉 Успех! Тебе начислено +${coins} монет`);
  }
}
