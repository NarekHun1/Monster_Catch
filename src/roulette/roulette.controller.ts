import { Controller, Post, Headers } from '@nestjs/common';
import { RouletteService } from './roulette.service';
import { AuthService } from '../auth/auth.service';

@Controller('roulette')
export class RouletteController {
  constructor(
    private readonly roulette: RouletteService,
    private readonly auth: AuthService,
  ) {}

  @Post('spin')
  async spin(@Headers('authorization') authorization: string) {
    const userId = this.auth.getUserIdFromToken(authorization);
    return this.roulette.spin(userId);
  }
}
