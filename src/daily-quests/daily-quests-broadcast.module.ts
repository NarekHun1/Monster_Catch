// src/daily-quests/daily-quests-broadcast.module.ts
import { Module } from '@nestjs/common';
import { DailyQuestsBroadcastService } from './daily-quests-broadcast.service';
import { DailyQuestsBroadcastController } from './daily-quests-broadcast.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationService } from '../notification/notification.service';
import { TelegrafModule } from 'nestjs-telegraf';
import { DailyQuestCron } from './daily-quest.cron';
import { PrismaService } from '../prisma/prisma.service';

@Module({
  imports: [PrismaModule, TelegrafModule],
  providers: [
    DailyQuestsBroadcastService,
    NotificationService,
    DailyQuestCron,
    PrismaService,
  ],
  controllers: [DailyQuestsBroadcastController],
})
export class DailyQuestsBroadcastModule {}
