import { Body, Controller, Post } from '@nestjs/common';
import { UserService } from '../src/user/user.service';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly userService: UserService) {}

  @Post('stars-success')
  async starsSuccess(
    @Body()
    body: {
      telegramId: string; // ctx.from.id.toString()
      coins: number; // сколько монет покупает пользователь
      stars: number; // сколько Stars он оплатил
      payload?: string; // invoice_payload
      paymentChargeId: string; // telegram_payment_charge_id
    },
  ) {
    console.log('Payment received from bot:', body);

    // 1. Находим пользователя
    const user = await this.userService.findByTelegramId(body.telegramId);

    if (!user) {
      return { ok: false, error: 'User not found' };
    }

    // 2. Начисляем монеты
    const updatedUser = await this.userService.addCoinsByTelegramId(
      body.telegramId,
      body.coins,
    );

    // 3. Записываем информацию о платеже в Payment
    await this.userService.createPayment({
      telegramPaymentChargeId: body.paymentChargeId,
      starsAmount: body.stars, // сколько Stars заплатил
      coinsAmount: body.coins, // сколько монет получил
      payload: body.payload,
      userId: user.id,
    });

    return {
      ok: true,
      coins: updatedUser.coins,
      balance: updatedUser.coins,
    };
  }
}
