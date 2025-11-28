// src/payment/payment.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { CreatePaymentDto } from './dto/create-payment.dto';

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('confirm')
  async confirmPayment(@Body() dto: CreatePaymentDto) {
    const payment = await this.paymentService.registerPayment(dto);

    return {
      success: true,
      paymentId: payment.id,
    };
  }
}
