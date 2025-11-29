import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationService } from '../notification/notification.service';

@Injectable()
export class DailyQuestCron {
  private readonly logger = new Logger(DailyQuestCron.name);

  constructor(private readonly notif: NotificationService) {}

  @Cron(CronExpression.EVERY_DAY_AT_NOON) // каждый день в 12:00
  async handleNoonCron() {
    this.logger.log('⏰ CRON: Запускаем рассылку ежедневных заданий');

    await this.notif.sendBroadcast(
      '🎯 Новые ежедневные задания!\nЗабери свои ⭐ награды прямо сейчас!',
    );

    this.logger.log('📨 Рассылка завершена');
  }
}
