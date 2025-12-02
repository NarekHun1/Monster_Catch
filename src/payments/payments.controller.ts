// src/payment/payment.controller.ts
import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { ConfigService } from '@nestjs/config';

@Controller('payment')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly config: ConfigService,
  ) {}

  @Post('confirm')
  async confirmPayment(@Body() dto: any) {
    const payment = await this.paymentService.registerPayment(dto);

    return {
      success: true,
      paymentId: payment.id,
    };
  }

  // 🔥 НОВОЕ: создаём Stars-invoice
  @Post('create-stars-invoice')
  async createStarsInvoice(@Body() body: { packId: string }) {
    const packs: Record<string, { starsPrice: number; coins: number }> = {
      coins_500: { starsPrice: 100, coins: 100 },
      coins_1000: { starsPrice: 150, coins: 150 },
      coins_2500: { starsPrice: 250, coins: 300 },
    };

    const pack = packs[body.packId];
    if (!pack) {
      throw new BadRequestException('Unknown packId');
    }

    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      throw new Error('TELEGRAM_BOT_TOKEN is not set');
    }

    const url = `https://api.telegram.org/bot${botToken}/createInvoiceLink`;

    // если у тебя Node 18+, можно так:
    const tgRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `${pack.coins} монет`,
        description: `Покупка ${pack.coins} монет`,
        payload: `buy_${body.packId}`,
        provider_token: '', // для Stars — пустая строка
        currency: 'XTR', // валюта Stars
        prices: [
          {
            label: `${pack.coins} монет`,
            amount: pack.starsPrice, // цена в Stars
          },
        ],
      }),
    });

    const tgData = await tgRes.json();

    if (!tgData.ok) {
      console.error('Telegram createInvoiceLink error:', tgData);
      throw new Error(
        tgData.description || 'Telegram createInvoiceLink failed',
      );
    }

    const invoiceLink: string = tgData.result;

    return { invoiceLink };
  }
}
