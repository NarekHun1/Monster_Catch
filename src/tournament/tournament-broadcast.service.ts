import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TournamentService } from './tournament.service';
import { Telegraf } from 'telegraf';
import { InjectBot } from 'nestjs-telegraf';

@Injectable()
export class TournamentBroadcastService {
  private readonly logger = new Logger(TournamentBroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tournamentService: TournamentService,
    @InjectBot() private readonly bot: Telegraf, // твой бот
  ) {}

  // каждый час, в начале часа
  @Cron('0 * * * *')
  async broadcastNewHourTournament() {
    const now = new Date();
    this.logger.log(
      `Checking tournament for broadcast at ${now.toISOString()}`,
    );

    const tournament =
      await this.tournamentService.getOrCreateCurrentTournament();

    // если турнир уже закончился — не спамим
    if (tournament.status === 'FINISHED') return;

    // проверяем, идёт ли окно входа (первые 10 минут часа)
    if (now > tournament.joinDeadline) {
      this.logger.log('Join window already closed, skip broadcast');
      return;
    }

    // достаём активных пользователей, например тех, у кого coins > 0
    const users = await this.prisma.user.findMany({
      where: {
        coins: { gt: 0 },
        // можно ещё фильтровать по lastSeenAt, чтобы не спамить мёртвые аккаунты
      },
      select: {
        telegramId: true,
        username: true,
        coins: true,
      },
    });

    if (!users.length) {
      this.logger.log('No users to notify');
      return;
    }

    // текст пуша — можешь выбрать любой из вариантов выше
    const text = [
      '🏆 Почасовой турнир стартанул!',
      '',
      '🎟 Вход: 1 монетка',
      '💰 Призовой фонд растёт с каждым участником',
      '',
      'У тебя есть ~10 минут, чтобы залететь:',
      'открой игру → вкладка «Турниры» → «Вступить в турнир».',
      '',
      '👾 Покажи всем, кто тут главный охотник на монстров!',
    ].join('\n');

    for (const u of users) {
      try {
        await this.bot.telegram.sendMessage(Number(u.telegramId), text, {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🎮 Открыть игру',
                  web_app: {
                    url: 'https://monster-catch-front.vercel.app',
                  }, // твой URL
                },
              ],
            ],
          },
        });
      } catch (e) {
        this.logger.warn(
          `Failed to send tournament msg to ${u.telegramId}: ${e.message}`,
        );
      }
    }

    this.logger.log(`Tournament broadcast sent to ${users.length} users`);
  }
}
