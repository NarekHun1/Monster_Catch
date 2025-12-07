// src/wallet/wallet.controller.ts
import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  BadRequestException,
} from '@nestjs/common';
import type { Request } from 'express';
import { WalletService } from './wallet.service';
import { AuthService } from '../auth/auth.service';

@Controller('wallet')
export class WalletController {
  constructor(
    private readonly walletService: WalletService,
    private readonly auth: AuthService, // 🔥 ЭТОТ ИМПОРТ ОБЯЗАТЕЛЕН
  ) {}

  // 📌 /wallet/info
  @Get('info')
  async getWalletInfo(@Req() req: Request) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) throw new BadRequestException('TOKEN_MISSING');

    return this.walletService.getWalletInfo(token);
  }

  // 📌 /wallet/addresses
  @Post('addresses')
  async saveAddresses(
    @Req() req: Request,
    @Body() body: { usdtAddress?: string; tonAddress?: string },
  ) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) throw new BadRequestException('TOKEN_MISSING');

    return this.walletService.saveAddresses(token, body);
  }

  // 📌 /wallet/withdraw
  @Post('withdraw')
  async withdraw(
    @Req() req: Request,
    @Body()
    body: {
      coins: number;
      currency: 'USDT' | 'TON';
      network: string;
      addressType: 'SAVED' | 'CUSTOM';
      customAddress?: string;
    },
  ) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) throw new BadRequestException('TOKEN_MISSING');

    return this.walletService.requestWithdrawal(token, body);
  }
}
