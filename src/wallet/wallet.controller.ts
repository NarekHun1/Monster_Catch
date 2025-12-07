// src/wallet/wallet.controller.ts
import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { WalletService } from './wallet.service';

function extractToken(req: Request, authHeader?: string): string | null {
  const header = authHeader ?? req.headers.authorization;
  if (!header) return null;
  const [type, token] = header.split(' ');
  if (type !== 'Bearer' || !token) return null;
  return token;
}

@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('info')
  async info(
    @Req() req: Request,
    @Headers('authorization') authHeader?: string,
  ) {
    const token = extractToken(req, authHeader);
    if (!token) throw new UnauthorizedException('TOKEN_MISSING');
    return this.wallet.getWalletInfo(token);
  }

  @Post('addresses')
  async saveAddresses(
    @Req() req: Request,
    @Body() body: { usdtAddress?: string; tonAddress?: string },
    @Headers('authorization') authHeader?: string,
  ) {
    const token = extractToken(req, authHeader);
    if (!token) throw new UnauthorizedException('TOKEN_MISSING');
    return this.wallet.saveAddresses(token, body);
  }
  @Post('set-address')
  async setAddress(
    @Req() req: Request,
    @Body()
    body: { tonAddress?: string; usdtAddress?: string; usdtNetwork?: string },
  ) {
    const userId = this.auth.getUserIdFromToken(req);

    const user = await this.wallet.setAddress(userId, body);
    return { ok: true, user };
  }

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
    @Headers('authorization') authHeader?: string,
  ) {
    const token = extractToken(req, authHeader);
    if (!token) throw new UnauthorizedException('TOKEN_MISSING');
    return this.wallet.requestWithdrawal(token, body);
  }
}
