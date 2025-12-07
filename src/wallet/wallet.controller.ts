import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { WalletService } from './wallet.service';
import { AuthService } from '../auth/auth.service';
import { WithdrawalCurrency } from '@prisma/client';

@Controller('wallet')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly auth: AuthService,
  ) {}

  private getUserIdFromRequest(req: Request): number {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.toString().replace('Bearer ', '').trim();
    if (!token) {
      throw new UnauthorizedException('TOKEN_MISSING');
    }
    return this.auth.getUserIdFromToken(token);
  }

  @Get('info')
  async info(@Req() req: Request) {
    const userId = this.getUserIdFromRequest(req);
    return this.wallet.getInfo(userId);
  }

  @Post('link-address')
  async linkAddress(
    @Req() req: Request,
    @Body() body: { type: 'USDT' | 'TON'; address: string },
  ) {
    const userId = this.getUserIdFromRequest(req);
    if (body.type !== 'USDT' && body.type !== 'TON') {
      throw new UnauthorizedException('UNSUPPORTED_TYPE');
    }
    return this.wallet.linkAddress(userId, body.type, body.address);
  }

  @Post('withdraw')
  async withdraw(
    @Req() req: Request,
    @Body()
    body: {
      currency: WithdrawalCurrency; // 'USDT' | 'TON'
      coinsAmount: number;
    },
  ) {
    const userId = this.getUserIdFromRequest(req);
    return this.wallet.requestWithdrawal(
      userId,
      body.currency,
      Number(body.coinsAmount),
    );
  }
}
