// src/event-tournament/event-tournament.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Query,
} from '@nestjs/common';
import { EventTournamentService } from './event-tournament.service';
import { JoinEventDto } from './  dto/join-event.dto';
import { SubmitScoreDto } from './  dto/submit-score.dto';

@Controller('event-tournament')
export class EventTournamentController {
  constructor(private readonly service: EventTournamentService) {}

  // GET /event-tournament/current?slug=big-march-2026
  @Get('current')
  async current(
    @Query('slug') slug?: string,
    @Headers('authorization') authHeader?: string,
  ) {
    if (!slug) throw new BadRequestException('slug is required');
    return this.service.getCurrentEvent(slug, authHeader);
  }

  // POST /event-tournament/join  { slug: "big-march-2026" }
  @Post('join')
  async join(
    @Headers('authorization') authHeader: string | undefined,
    @Body() dto: JoinEventDto,
  ) {
    if (!authHeader) throw new BadRequestException('Authorization missing');
    return this.service.joinEvent(authHeader, dto.slug);
  }

  // POST /event-tournament/submit-score { slug: "...", score: 123 }
  @Post('submit-score')
  async submitScore(
    @Headers('authorization') authHeader: string | undefined,
    @Body() dto: SubmitScoreDto,
  ) {
    if (!authHeader) throw new BadRequestException('Authorization missing');
    return this.service.submitScore(authHeader, dto.slug, dto.score);
  }
}
