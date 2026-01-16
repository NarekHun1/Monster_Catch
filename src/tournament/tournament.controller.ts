import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  Query,
  BadRequestException,
  UnauthorizedException,
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
  join(
    @Headers('authorization') auth: string,
    @Body() body: { type: TournamentType; entry: 'TICKET' | 'COINS' },
  ) {
    if (!auth) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    const token = auth.replace('Bearer ', '');

    const payWith = body.entry === 'TICKET' ? 'tickets' : 'coins';

    return this.service.join(token, body.type, payWith);
  }

  // ─────────────────────────────────────
  // ОТПРАВКА СЧЁТА В ТУРНИР
  // POST /tournament/submit-score
  // body: { type: "HOURLY" | "DAILY", score: number }
  // ─────────────────────────────────────
  @Post('submit-score')
  async submitScore(
    @Headers('authorization') auth?: string,
    @Body('tournamentId') tournamentId?: number,
    @Body('score') score?: number,
  ) {
    if (typeof tournamentId !== 'number') {
      throw new BadRequestException('TournamentId must be a number');
    }
    if (typeof score !== 'number') {
      throw new BadRequestException('Score must be a number');
    }

    const token = this.extractToken(auth);

    return this.service.submitScore(token, tournamentId, score);
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
