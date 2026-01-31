// src/telegram/telegram.update.ts
import { Ctx, Start, Update, On, Action } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { ConfigService } from '@nestjs/config';
import { UserService } from '../user/user.service';
import { PaymentService } from '../payments/payment.service';

/* ───────────────────────────────────────────────
   Safe Telegram send (ignore "bot was blocked")
─────────────────────────────────────────────── */

function isBotBlocked(err: any) {
  const code = err?.response?.error_code;
  const desc = String(err?.response?.description || '').toLowerCase();
  return code === 403 && desc.includes('bot was blocked by the user');
}

async function safeTg<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (isBotBlocked(e)) return null;
    throw e;
  }
}

function escMdV2(s: string) {
  // MarkdownV2 escape
  return s.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// ───────────────────────────────────────────────
// TEXTS (source as normal text → escaped to MarkdownV2)
// ───────────────────────────────────────────────

const START_RAW = `
👾 Добро пожаловать в MONSTER CATCH!

Telegram-игра, где ты
🎮 играешь
🏆 участвуешь в турнирах
💎 и получаешь призы в TON
`.trim();

const HOW_TO_PLAY_RAW = `
🎮 Как играть

⭐️ ИГРАЙ БЕСПЛАТНО
— Лови монстров
— Зарабатывай ⭐ звёзды
— Обменивай их на 🎟 билеты
— Участвуй в турнирах

💳 ХОЧЕШЬ БЫСТРЕЕ?
— Покупай игровые 🪙 коины
— Заходи в турниры сразу

━━━━━━━━━━━━━━━
🏆 ТУРНИРЫ И ПРИЗЫ

🥇 1 место — 40% фонда
🥈 2 место — 20%
🥉 3 место — 10%

💎 Призы выплачиваются в TON

━━━━━━━━━━━━━━━
👛 Вывод средств
Подключай любой TON-кошелёк
и выводи заработанные призы

⚠️ Победа зависит от навыков и активности
`.trim();

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

    // 1️⃣ Upsert user
    const user = await this.users.upsertFromTelegram({
      id: tgUser.id,
      username: tgUser.username,
      first_name: tgUser.first_name,
    });

    // 2️⃣ payload (/start ref_xxx)
    let payload: string | undefined;
    if (
      ctx.message &&
      'text' in ctx.message &&
      typeof (ctx.message as any).text === 'string'
    ) {
      payload = (ctx.message as any).text.split(' ')[1];
    }

    // 3️⃣ referral
    if (payload?.startsWith('ref_')) {
      const inviterTelegramId = payload.replace('ref_', '');
      await this.users.registerReferralByTelegramId(inviterTelegramId, user.id);
    }

    // 4️⃣ urls
    const webAppUrl =
      this.config.get('WEBAPP_URL') || 'https://monster-catch-front.vercel.app';

    const channelUrl = 'https://t.me/monstercatchgame';

    // 5️⃣ start message + buttons
    await safeTg(() =>
      ctx.reply(escMdV2(START_RAW), {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎮 Играть', web_app: { url: webAppUrl } }],
            [{ text: '📣 Подписаться на канал', url: channelUrl }],
            [{ text: '❓ Как играть', callback_data: 'HOW_TO_PLAY' }],
          ],
        },
      }),
    );
  }

  // ───────────────────────────────
  // HOW TO PLAY (callback)
  // ───────────────────────────────
  @Action('HOW_TO_PLAY')
  async onHowToPlay(@Ctx() ctx: any) {
    // убрать "часики" на кнопке
    await safeTg(() => ctx.answerCbQuery());

    const webAppUrl =
      this.config.get('WEBAPP_URL') || 'https://monster-catch-front.vercel.app';

    await safeTg(() =>
      ctx.reply(escMdV2(HOW_TO_PLAY_RAW), {
        parse_mode: 'MarkdownV2',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎮 Играть', web_app: { url: webAppUrl } }],
          ],
        },
      }),
    );
  }

  // ───────────────────────────────
  // pre_checkout_query
  // ───────────────────────────────
  @On('pre_checkout_query')
  async onPreCheckout(@Ctx() ctx: any) {
    await safeTg(() => ctx.answerPreCheckoutQuery(true));
  }

  // ───────────────────────────────
  // successful_payment
  // ───────────────────────────────
  @On('successful_payment')
  async onSuccess(@Ctx() ctx: any) {
    const payment = ctx.message.successful_payment;
    const telegramId = String(ctx.from.id);

    const packId = payment.invoice_payload.replace('buy_', '');

    const packs: Record<string, number> = {
      coins_500: 100,
      coins_1000: 150,
      coins_2500: 300,
    };

    const coins = packs[packId];
    if (!coins) {
      await safeTg(() => ctx.reply('Ошибка товара ❌'));
      return;
    }

    await this.payments.registerPayment({
      telegramPaymentChargeId: payment.telegram_payment_charge_id,
      starsAmount: payment.total_amount,
      coinsAmount: coins,
      userTelegramId: telegramId,
      payload: payment.invoice_payload,
    });

    await safeTg(() => ctx.reply(`🎉 Успешно! +${coins} монет 🪙`));
  }
}
