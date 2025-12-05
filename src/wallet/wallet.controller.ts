import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { WalletService } from './wallet.service';
import { CreateWithdrawDto } from './dto/create-withdraw.dto';
import { AuthService } from '../auth/auth.service';

@Controller('wallet')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly auth: AuthService,
  ) {}

  /** Достаём userId из заголовка Authorization: Bearer <token> */
  private getUserIdFromRequest(req: any): number {
    const authHeader: string | undefined =
      req.headers['authorization'] || req.headers['Authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    const token = authHeader.replace('Bearer ', '').trim();
    return this.auth.getUserIdFromToken(token);
  }

  @Post('withdraw')
  async withdraw(@Req() req, @Body() dto: CreateWithdrawDto) {
    const userId = this.getUserIdFromRequest(req);

    return this.wallet.requestWithdraw(
      userId,
      dto.coins,
      dto.network,
      dto.address,
    );
  }

  @Get('withdrawals')
  async getMyWithdrawals(@Req() req) {
    const userId = this.getUserIdFromRequest(req);
    return this.wallet.listUserWithdrawals(userId);
  }
}
