import {
  Controller,
  Get,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { TicketsService } from './tickets.service';
import { AuthService } from '../auth/auth.service';

@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly ticketsService: TicketsService,
    private readonly authService: AuthService,
  ) {}

  @Get('count')
  count(@Req() req: any) {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');
    const userId = this.authService.getUserIdFromToken(token);

    return this.ticketsService.getTicketsCount(userId);
  }

  @Post('exchange-stars')
  exchangeStars(@Req() req: any) {
    // 1️⃣ Берём Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      throw new UnauthorizedException('NO_AUTH_HEADER');
    }

    // 2️⃣ Достаём token
    const token = authHeader.replace('Bearer ', '');

    // 3️⃣ Получаем userId (ТВОЙ код, уже есть)
    const userId = this.authService.getUserIdFromToken(token);

    // 4️⃣ Обмен ⭐ → 🎟
    return this.ticketsService.exchangeStars(userId);
  }
}
