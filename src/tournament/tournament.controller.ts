import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { TournamentService } from './tournament.service';
import { TournamentType } from '@prisma/client';

@Controller('tournament')
export class TournamentController {
  constructor(private readonly service: TournamentService) {}

  // ─────────────────────────────────────
  // JWT helper
  // ─────────────────────────────────────
  private extractToken(authHeader?: string): string {
    if (!authHeader) {
      throw new BadRequestException('Missing Authorization header');
    }

    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      throw new BadRequestException('Invalid Authorization header');
    }

    return token;
  }

  // ─────────────────────────────────────
  // ТЕКУЩИЙ ТУРНИР + ЛИДЕРБОРД
  // GET /tournament/current?type=HOURLY|DAILY
  // ─────────────────────────────────────
  @Get('current')
  async current(
    @Query('type') type?: TournamentType,
    @Headers('authorization') auth?: string,
  ) {
    if (!type) {
      throw new BadRequestException('Tournament type is required');
    }

    const token =
      auth && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;

    return this.service.getCurrentTournament(type, token);
  }

  // ─────────────────────────────────────
  // ВСТУПЛЕНИЕ В ТУРНИР
  // POST /tournament/join
  // body: { type: "HOURLY" | "DAILY" }
  // ─────────────────────────────────────
  @Post('join')
  async join(
    @Headers('authorization') auth?: string,
    @Body('type') type?: TournamentType,
  ) {
    if (!type) {
      throw new BadRequestException('Tournament type is required');
    }

    const token = this.extractToken(auth);
    return this.service.join(token, type);
  }

  // ─────────────────────────────────────
  // ОТПРАВКА СЧЁТА В ТУРНИР
  // POST /tournament/submit-score
  // body: { type: "HOURLY" | "DAILY", score: number }
  // ─────────────────────────────────────
  @Post('submit-score')
  async submitScore(
    @Headers('authorization') auth?: string,
    @Body('type') type?: TournamentType,
    @Body('score') score?: number,
  ) {
    if (!type) {
      throw new BadRequestException('Tournament type is required');
    }
    if (typeof score !== 'number') {
      throw new BadRequestException('Score must be a number');
    }

    const token = this.extractToken(auth);
    return this.service.submitScore(token, type, score);
  }

  // ─────────────────────────────────────
  // ЗАВЕРШЕНИЕ ТУРНИРОВ (cron / manual)
  // POST /tournament/finish-expired
  // ─────────────────────────────────────
  @Post('finish-expired')
  async finishExpired() {
    return this.service.finishExpiredTournaments();
  }
}
