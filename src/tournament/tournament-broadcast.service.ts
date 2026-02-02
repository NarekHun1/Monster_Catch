import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { TournamentService } from './tournament.service';
import { Telegraf } from 'telegraf';
import { InjectBot } from 'nestjs-telegraf';
import { TournamentType } from '@prisma/client';

@Injectable()
export class TournamentBroadcastService {
  private readonly logger = new Logger(TournamentBroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tournamentService: TournamentService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}
  // ================================
  // 🆕 ОДНОРАЗОВАЯ РАССЫЛКА: INVITE FRIENDS
  // ================================
  async broadcastInviteFriendsOnce() {
    this.logger.log('Starting invite friends broadcast');

    const users = await this.prisma.user.findMany({
      where: {
        telegramId: { not: '' },
        isBlocked: false,
      },
      select: {
        telegramId: true,
      },
    });

    if (!users.length) {
      this.logger.log('No users to notify');
      return { total: 0, sent: 0, failed: 0 };
    }

    const text = [
      '👥 Пригласи друзей в игру!',
      '',
      'Поделись своей ссылкой с друзьями —',
      'за каждого приглашённого ты получишь 🎟 5 билетов.',
      '',
      'Открой игру → «Пригласить друзей».',
    ].join('\n');

    let sent = 0;
    let failed = 0;

    for (const u of users) {
      try {
        await this.bot.telegram.sendMessage(Number(u.telegramId), text);
        sent++;
      } catch (e: any) {
        failed++;
        this.logger.warn(
          `Failed invite broadcast to ${u.telegramId}: ${e.message}`,
        );
      }

      // 🛑 анти-лимит Telegram
      await new Promise((r) => setTimeout(r, 100));
    }

    this.logger.log(
      `Invite broadcast finished. Sent=${sent}, Failed=${failed}`,
    );

    return {
      total: users.length,
      sent,
      failed,
    };
  }
}
// ⏱ каждый час, в начале часа — ТОЛЬКО HOURLY
//   @Cron('0 * * * *')
//   async broadcastNewHourTournament() {
//     const now = new Date();
//     this.logger.log(
//       `Checking HOURLY tournament for broadcast at ${now.toISOString()}`,
//     );
//
//     // ✅ ПРАВИЛЬНО
//     const tournament = await this.tournamentService.getOrCreateTournament(
//       TournamentType.HOURLY,
//     );
//
//     // если турнир уже закончился — не спамим
//     if (tournament.status === 'FINISHED') return;
//
//     // если окно входа закрыто — не спамим
//     if (now > tournament.joinDeadline) {
//       this.logger.log('Join window already closed, skip broadcast');
//       return;
//     }
//
//     // активные пользователи
//     const users = await this.prisma.user.findMany({
//       where: {
//         coins: { gt: 0 },
//         telegramId: { not: '' },
//       },
//       select: {
//         telegramId: true,
//         username: true,
//         coins: true,
//       },
//     });
//
//     if (!users.length) {
//       this.logger.log('No users to notify');
//       return;
//     }
//
//     const text = [
//       '🏆 Почасовой турнир стартовал!',
//       '',
//       '🎟 Вход: 50 монет',
//       '💰 Призовой фонд растёт с каждым участником',
//       '',
//       '⏳ У тебя есть ~10 минут, чтобы вступить:',
//       'Открой игру → вкладка «Турниры» → «Вступить».',
//       '',
//       '⚔️ Докажи, что ты лучший охотник на монстров!',
//     ].join('\n');
//
//     for (const u of users) {
//       try {
//         await this.bot.telegram.sendMessage(Number(u.telegramId), text);
//       } catch (e: any) {
//         this.logger.warn(
//           `Failed to send tournament msg to ${u.telegramId}: ${e.message}`,
//         );
//       }
//     }
//
//     this.logger.log(
//       `HOURLY tournament broadcast sent to ${users.length} users`,
//     );
//   }
// }
