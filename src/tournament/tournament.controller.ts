import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { TournamentService } from './tournament.service';

@Controller('tournament')
export class TournamentController {
  constructor(private readonly service: TournamentService) {}

  private extractToken(authHeader?: string): string {
    if (!authHeader) throw new Error('Missing Authorization');
    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) throw new Error('Invalid Authorization');
    return token;
  }

  @Get('current')
  async current() {
    return this.service.getCurrentLeaderboard();
  }

  @Post('join')
  async join(@Headers('authorization') auth?: string) {
    const token = this.extractToken(auth);
    return this.service.join(token);
  }

  @Post('submit-score')
  async submitScore(
    @Headers('authorization') auth?: string,
    @Body() body?: { tournamentId: number; score: number },
  ) {
    const token = this.extractToken(auth);

    if (!body) {
      throw new BadRequestException('Missing body');
    }
    if (body.tournamentId == null || body.score == null) {
      throw new BadRequestException('Invalid payload');

    }

    return this.service.submitScore(token, body.tournamentId, body.score);
  }

  // можно дергать кроном: POST /tournament/finish-expired
  @Post('finish-expired')
  async finishExpired() {
    return this.service.finishExpiredTournaments();
  }
}
