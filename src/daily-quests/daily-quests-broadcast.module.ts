// src/daily-quests/daily-quests-broadcast.module.ts
import { Module } from '@nestjs/common';
import { DailyQuestsBroadcastService } from './daily-quests-broadcast.service';
import { DailyQuestsBroadcastController } from './daily-quests-broadcast.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { TelegrafModule } from 'nestjs-telegraf';
import { DailyQuestCron } from './daily-quest.cron';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [PrismaModule, TelegrafModule, NotificationModule],
  providers: [
    DailyQuestsBroadcastService,
    NotificationService,
    DailyQuestCron,
    PrismaService,
  ],
  controllers: [DailyQuestsBroadcastController],
})
export class DailyQuestsBroadcastModule {}
