import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { GameService } from './game.service';
import { FinishGameDto } from './finish-game.dto';

@Controller('game')
export class GameController {
  constructor(private readonly gameService: GameService) {}

  /** Достаём Bearer token из Authorization header */
  private extractToken(authHeader?: string): string {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }

    return authHeader.slice(7);
  }

  @Post('start')
  async start(@Headers('authorization') authHeader?: string) {
    const token = this.extractToken(authHeader);
    return this.gameService.startGame(token);
  }

  @Get('leaderboard')
  async leaderboard() {
    return this.gameService.getLeaderboard();
  }

  @Get('daily-quests')
  async dailyQuests(@Headers('authorization') authHeader?: string) {
    const token = this.extractToken(authHeader);
    return this.gameService.getDailyQuests(token);
  }

  @Post('finish')
  async finish(
    @Headers('authorization') authHeader?: string,
    @Body() body?: FinishGameDto,
  ) {
    const token = this.extractToken(authHeader);

    return this.gameService.finishGame(
      token,
      Number(body?.gameId ?? 0),
      Number(body?.score ?? 0),
      Number(body?.clicks ?? 0),
      Number(body?.epicCount ?? 0),
      Number(body?.melasCount ?? 0),
      Array.isArray(body?.rawTaps) ? body.rawTaps : [],
    );
  }

  @Post('daily-quests/claim')
  async claimDailyQuest(
    @Headers('authorization') authHeader?: string,
    @Body() body?: { questId: string },
  ) {
    const token = this.extractToken(authHeader);
    return this.gameService.claimDailyQuest(token, body?.questId || '');
  }
}