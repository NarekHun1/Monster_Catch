// src/daily-quests/daily-quests-broadcast.controller.ts
import { Controller, Post } from '@nestjs/common';
import { DailyQuestsBroadcastService } from './daily-quests-broadcast.service';

@Controller('admin/daily-quests')
export class DailyQuestsBroadcastController {
  constructor(private readonly broadcastService: DailyQuestsBroadcastService) {}

  // POST /admin/daily-quests/broadcast
  @Post('broadcast')
  async broadcastToday() {
    return this.broadcastService.broadcastTodayDailyQuestsPromo();
  }
}
