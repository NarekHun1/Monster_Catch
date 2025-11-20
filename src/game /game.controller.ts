import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { GameService } from './game.service';

@Controller('game')
export class GameController {
  constructor(private readonly gameService: GameService) {}

  /** Вытаскиваем Bearer-токен из заголовка Authorization */
  private extractToken(authHeader?: string): string {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException(
        'Missing or invalid Authorization header',
      );
    }
    return authHeader.slice(7); // после "Bearer "
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
    @Body() body?: any,
  ) {
    console.log('[/game/finish] raw body =', body);

    const token = this.extractToken(authHeader);
    const gameId = Number(body?.gameId);
    const score = Number(body?.score);
    const clicks = Number(body?.clicks ?? 0);
    const epicCount = Number(body?.epicCount ?? 0);

    console.log('[/game/finish] parsed =', {
      gameId,
      score,
      clicks,
      epicCount,
    });

    return this.gameService.finishGame(token, gameId, score, clicks, epicCount);
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
