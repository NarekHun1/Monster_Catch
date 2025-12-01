// src/payment/payment.controller.ts
import { Body, Controller, Post, BadRequestException } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Controller('payment')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly config: ConfigService,
  ) {}

  @Post('confirm')
  async confirmPayment(@Body() dto: CreatePaymentDto) {
    const payment = await this.paymentService.registerPayment(dto);

    return {
      success: true,
      paymentId: payment.id,
    };
  }

  // 🔥 новый метод — создаёт invoice link для Stars
  @Post('create-stars-invoice')
  async createStarsInvoice(@Body() body: { packId: string }) {
    const packs: Record<
      string,
      { starsPrice: number; coins: number; title: string }
    > = {
      coins_500: { starsPrice: 100, coins: 500, title: '500 монет' },
      coins_1000: { starsPrice: 180, coins: 1000, title: '1000 монет' },
      coins_2500: { starsPrice: 400, coins: 2500, title: '2500 монет' },
    };

    const pack = packs[body.packId];
    if (!pack) {
      throw new BadRequestException('Unknown packId');
    }

    const botToken = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      throw new Error('No TELEGRAM_BOT_TOKEN in config');
    }

    // ⚠️ Stars: currency = 'XTR', provider_token = ''
    const payload = `buy_${body.packId}`;

    const tgUrl = `https://api.telegram.org/bot${botToken}/createInvoiceLink`;

    const resp = await axios.post(tgUrl, {
      title: pack.title,
      description: `Покупка ${pack.coins} монет`,
      payload,
      provider_token: '',
      currency: 'XTR',
      prices: [
        {
          label: pack.title,
          amount: pack.starsPrice,
        },
      ],
    });

    if (!resp.data?.ok) {
      console.error('Telegram createInvoiceLink error:', resp.data);
      throw new Error('Cannot create invoice link');
    }

    const invoiceLink: string = resp.data.result;
    return {
      link: invoiceLink,
      coins: pack.coins,
    };
  }
}
