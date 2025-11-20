import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { Context } from 'telegraf';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    @InjectBot() private readonly bot: Telegraf<Context>,
    private readonly prisma: PrismaService,
  ) {}

  async sendTextToTelegramId(telegramId: string | number, text: string) {
    try {
      await this.bot.telegram.sendMessage(Number(telegramId), text);
    } catch (e) {
      this.logger.error(
        `Failed to send message to ${telegramId}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  async sendReferralReward(telegramId: string | number, reward: number) {
    const msg = `🎉 Ты получил +${reward} ⭐ за первую игру друга! Спасибо, что зовёшь в Monster Catch 🙌`;
    await this.sendTextToTelegramId(telegramId, msg);
  }
  async sendDailyQuestsPromo(telegramId: string | number) {
    const text =
      '🎯 Ежедневные задания в Monster Catch!\n\n' +
      'Заходи сегодня, выполняй задания и забирай ⭐ награды.\n' +
      'Чем чаще играешь — тем больше бонусов каждый день.';

    await this.sendTextToTelegramId(telegramId, text);
  }

  /** 🔥 Массовая рассылка всем пользователям с telegramId */
  async sendBroadcast(text: string) {
    this.logger.log('Начинаем рассылку всем пользователям...');

    const users = await this.prisma.user.findMany({
      where: { telegramId: { not: '' } },
      select: { telegramId: true },
    });

    this.logger.log(`Всего пользователей для рассылки: ${users.length}`);

    for (const u of users) {
      if (!u.telegramId) continue;
      await this.sendTextToTelegramId(u.telegramId, text);
      await new Promise((res) => setTimeout(res, 50)); // Задержка 50мс чтобы Telegram не забанил flood
    }

    this.logger.log('Рассылка завершена!');
  }
}
