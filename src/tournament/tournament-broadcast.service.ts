import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { ConfigService } from '@nestjs/config';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class TournamentBroadcastService {
  private readonly logger = new Logger(TournamentBroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  /**
   * 1) Upload photo via Insomnia (multipart/form-data)
   * 2) We send it to ADMIN_TG_ID to get Telegram file_id
   * 3) Return file_id -> use it in broadcast
   */
  async uploadPhotoAndGetFileId(file: Express.Multer.File) {
    if (!file) throw new BadRequestException('photo is required');

    const adminIdStr = this.config.get<string>('ADMIN_TG_ID');
    if (!adminIdStr) {
      throw new BadRequestException('ADMIN_TG_ID is not set in env');
    }

    const adminChatId = Number(adminIdStr);
    if (!Number.isFinite(adminChatId)) {
      throw new BadRequestException('ADMIN_TG_ID must be a number');
    }

    // Send to admin to make Telegram store it, return file_id
    const msg = await this.bot.telegram.sendPhoto(
      adminChatId,
      { source: file.buffer }, // ✅ buffer from multer memory storage
      {
        caption: `✅ Uploaded banner: ${file.originalname}`,
      },
    );

    const best = msg.photo?.[msg.photo.length - 1];
    const fileId = best?.file_id;

    if (!fileId) {
      throw new BadRequestException(
        'Failed to extract file_id from Telegram response',
      );
    }

    return {
      fileId,
      width: best.width,
      height: best.height,
      fileSize: best.file_size,
    };
  }

  /**
   * One-time broadcast (photo + caption)
   * Use file_id (best) OR public url.
   */
  async broadcastBigTournamentOnce(params: {
    photo: string; // file_id OR https url
    botLink: string; // https://t.me/monster_catch_bot
  }) {
    const text = [
      '🏆 <b>Большой турнир уже в игре!</b>',
      '',
      '💰 Приз: <b>10 000 COIN</b> ~100$',
      '',
      '🔥 Чем больше очков — тем ближе победа.',
      '',
      '⏳ Успей принять участие до <b>1 марта</b>',
      '',
      '⚔️ Заходи в игру и докажи, что ты лучший охотник.',
    ].join('\n');

    const users = await this.prisma.user.findMany({
      where: {
        telegramId: { not: '' },
        isBlocked: false,
      },
      select: {
        id: true,
        telegramId: true,
      },
      orderBy: { id: 'asc' },
    });

    if (!users.length) {
      return { total: 0, sent: 0, failed: 0, blocked: 0 };
    }

    let sent = 0;
    let failed = 0;
    let blocked = 0;

    for (const u of users) {
      const chatId = Number(u.telegramId);
      if (!Number.isFinite(chatId)) continue;

      try {
        await this.bot.telegram.sendPhoto(chatId, params.photo, {
          caption: text + `\n\n👉 ${params.botLink}`,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🔥 Играть сейчас',
                  url: params.botLink,
                },
              ],
            ],
          },
        });

        sent++;
        await sleep(90); // ✅ анти-лимит (~11 msg/sec)
      } catch (e: any) {
        failed++;

        const desc = e?.response?.description || e?.message || String(e);

        // ✅ если бот заблокирован / чат недоступен — пометим user.isBlocked=true
        if (
          String(desc).includes('bot was blocked') ||
          String(desc).includes('chat not found') ||
          String(desc).includes('user is deactivated')
        ) {
          blocked++;
          try {
            await this.prisma.user.update({
              where: { id: u.id },
              data: { isBlocked: true },
            });
          } catch {}
        }

        // ✅ если 429, Telegram иногда отдаёт retry_after
        const retryAfter = e?.response?.parameters?.retry_after;
        if (typeof retryAfter === 'number') {
          this.logger.warn(`429 retry_after=${retryAfter}s`);
          await sleep((retryAfter + 1) * 1000);
        } else {
          await sleep(150);
        }

        this.logger.warn(`Failed broadcast to ${u.telegramId}: ${desc}`);
      }
    }

    return { total: users.length, sent, failed, blocked };
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
