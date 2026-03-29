import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  Query,
  Param,
  ParseIntPipe,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { TournamentService } from './tournament.service';
import { TournamentType } from '@prisma/client';

@Controller('tournament')
export class TournamentController {
  constructor(private readonly service: TournamentService) {}

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

  @Post('join')
  join(
    @Headers('authorization') auth: string,
    @Body() body: { type: TournamentType; payWith?: 'tickets' | 'coins' },
  ) {
    if (!auth) throw new UnauthorizedException('Missing Authorization header');
    const token = auth.replace('Bearer ', '');

    const payWith = body.payWith;

    if (body.type === 'CASH_CUP' && !payWith) {
      throw new BadRequestException(
        'payWith is required for CASH_CUP (coins|tickets)',
      );
    }

    if (payWith && payWith !== 'tickets' && payWith !== 'coins') {
      throw new BadRequestException('payWith must be coins or tickets');
    }

    return this.service.join(token, body.type, payWith);
  }

  @Post(':id/invite-online')
  inviteOnline(
    @Param('id') id: string,
    @Headers('authorization') authorization: string,
  ) {
    return this.service.inviteOnline(authorization, Number(id));
  }

  @Post('invite/:inviteId/accept')
  acceptInvite(
    @Param('inviteId') inviteId: string,
    @Headers('authorization') authorization?: string,
    @Body() dto?: { payWith: 'coins' | 'tickets' },
  ) {
    const token = this.extractToken(authorization);

    if (dto?.payWith && dto.payWith !== 'coins' && dto.payWith !== 'tickets') {
      throw new BadRequestException('payWith must be coins or tickets');
    }

    return this.service.acceptInvite(
      token,
      Number(inviteId),
      dto?.payWith || 'coins',
    );
  }
  @Post('invite/:inviteId/decline')
  declineInvite(
    @Param('inviteId') inviteId: string,
    @Headers('authorization') auth?: string,
  ) {
    const token = this.extractToken(auth);
    return this.service.declineInvite(token, Number(inviteId));
  }
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

  @Post(':tournamentId/replay')
  buyReplay(
    @Param('tournamentId', ParseIntPipe) tournamentId: number,
    @Headers('authorization') auth?: string,
  ) {
    const token = this.extractToken(auth);
    return this.service.buyReplay(token, tournamentId);
  }

  @Post('finish-expired')
  async finishExpired() {
    return this.service.finishExpiredTournaments();
  }
}
