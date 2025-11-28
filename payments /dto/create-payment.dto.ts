// src/payment/dto/create-payment.dto.ts
import { IsString, IsNumber, IsOptional } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  telegramPaymentChargeId: string;

  @IsNumber()
  starsAmount: number;

  @IsNumber()
  coinsAmount: number;

  @IsOptional()
  @IsString()
  payload?: string;

  @IsString()
  userTelegramId: string;
}
