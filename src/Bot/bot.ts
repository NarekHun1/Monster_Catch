import { Telegraf } from 'telegraf';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN!;
const BACKEND_URL = process.env.VITE_API_BASE_URL!; // например: https://myserver.com

const bot = new Telegraf(BOT_TOKEN);

// 🎁 Пакеты монет (можешь изменить)
const COIN_PACKS = {
  coins_500: {
    coins: 2,
    stars: 100,
    title: '500 Coins',
    description: 'Пакет из 500 монет для игры',
  },
  coins_1000: {
    coins: 3,
    stars: 180,
    title: '1000 Coins',
    description: 'Пакет из 1000 монет для игры',
  },
};

// —————————————————————————————
//   1. Пользователь нажал "Buy Coins" в WebApp
// —————————————————————————————
bot.on('message', async (ctx) => {
  const msg: any = ctx.message;

  if (!msg.web_app_data) return; // если не WebApp → игнор

  const data = JSON.parse(msg.web_app_data.data);
  console.log('WebApp DATA:', data);

  if (data.action === 'buy_coins') {
    const packId = data.packId;
    const pack = COIN_PACKS[packId];

    if (!pack) {
      return ctx.reply('Неизвестный пакет монет.');
    }

    // —————————————————————————————
    // 2. Отправляем пользователю Stars Invoice
    // —————————————————————————————
    return ctx.replyWithInvoice({
      title: pack.title,
      description: pack.description,
      payload: packId, // важно!
      provider_token: '', // Stars → пусто
      currency: 'XTR',
      prices: [{ label: pack.title, amount: pack.stars }],
    });
  }
});

// —————————————————————————————
//   3. Telegram спрашивает разрешение на оплату
// —————————————————————————————
bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

// —————————————————————————————
//   4. Пользователь успешно оплатил Stars
// —————————————————————————————
bot.on('successful_payment', async (ctx) => {
  // @ts-ignore
  const payment = ctx.message.successful_payment;

  const userTelegramId = ctx.from.id.toString();
  const payload = payment.invoice_payload; // coins_500
  const pack = COIN_PACKS[payload];

  if (!pack) {
    return ctx.reply('Ошибка: неизвестный пакет после оплаты.');
  }

  try {
    // —————————————————————————————
    // 5. Отправляем данные о платеже в твой backend
    // —————————————————————————————
    const res = await axios.post(`${BACKEND_URL}/payments/stars-success`, {
      telegramId: userTelegramId,
      coins: pack.coins,
      stars: payment.total_amount,
      payload,
      paymentChargeId: payment.telegram_payment_charge_id,
    });

    const balance = res.data.balance;

    return ctx.reply(
      `🎉 Оплата прошла успешно!\n` +
        `Вы получили: ${pack.coins} монет 💰\n` +
        `Ваш новый баланс: ${balance}`,
    );
  } catch (error) {
    console.error(error);
    ctx.reply('Оплата прошла, но произошла ошибка начисления монет!');
  }
});

// —————————————————————————————
//   Запуск бота
// —————————————————————————————
bot.launch().then(() => {
  console.log('Bot is running...');
});
