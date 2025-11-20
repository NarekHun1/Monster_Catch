// src/referral/referral.controller.ts
import {
  Controller,
  Get,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ReferralService } from './referral.service';
import { AuthService } from '../src/auth/auth.service';

@Controller('referral') // => будет /referral/link
export class ReferralController {
  constructor(
    private readonly referralService: ReferralService,
    private readonly authService: AuthService,
  ) {}

  private extractToken(authHeader?: string): string {
    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }
    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      throw new UnauthorizedException('Invalid Authorization header');
    }
    return token;
  }

  @Get('link') // GET /referral/link
  async getReferralLink(@Headers('authorization') authHeader?: string) {
    const token = this.extractToken(authHeader);
    const userId = this.authService.getUserIdFromToken(token);

    return this.referralService.getReferralLinkForUser(userId);
  }
}
