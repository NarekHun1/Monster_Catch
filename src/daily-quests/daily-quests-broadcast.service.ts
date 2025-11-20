// src/daily-quests/daily-quests-broadcast.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationService } from '../notification/notification.service';

@Injectable()
export class DailyQuestsBroadcastService {
  private readonly logger = new Logger(DailyQuestsBroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
  ) {}

  // Вызвать один раз вручную сегодня
  async broadcastTodayDailyQuestsPromo() {
    const users = await this.prisma.user.findMany({
      where: {
        telegramId: { not: '' },
      },
      select: {
        id: true,
        telegramId: true,
      },
    });

    this.logger.log(`Sending daily quests promo to ${users.length} users`);

    for (const u of users) {
      if (!u.telegramId) continue;

      await this.notificationService.sendDailyQuestsPromo(u.telegramId);
      // при желании можно добавить маленькую задержку, чтобы не триггерить лимиты
      // await new Promise((r) => setTimeout(r, 50));
    }

    return { ok: true, sent: users.length };
  }
}
