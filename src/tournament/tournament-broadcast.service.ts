import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { ConfigService } from '@nestjs/config';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stripDataUrl(base64: string) {
  // supports "data:image/png;base64,...."
  const m = base64.match(/^data:([^;]+);base64,(.*)$/);
  if (m) return { mime: m[1], b64: m[2] };
  return { mime: undefined as string | undefined, b64: base64 };
}

@Injectable()
export class TournamentBroadcastService {
  private readonly logger = new Logger(TournamentBroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  /**
   * Convert base64 -> Buffer -> send to ADMIN_TG_ID -> return Telegram file_id
   */
  async photoBase64ToTelegramFileId(input: {
    photoBase64: string;
    filename?: string;
  }) {
    const adminIdStr = this.config.get<string>('ADMIN_TG_ID');
    if (!adminIdStr) throw new BadRequestException('ADMIN_TG_ID is not set');

    const adminChatId = Number(adminIdStr);
    if (!Number.isFinite(adminChatId)) {
      throw new BadRequestException('ADMIN_TG_ID must be a number');
    }

    const { b64 } = stripDataUrl(input.photoBase64);

    let buf: Buffer;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      throw new BadRequestException('Invalid base64');
    }

    // safety: base64 JSON can be heavy, keep < 8MB
    if (!buf?.length) throw new BadRequestException('Empty image buffer');
    if (buf.length > 8 * 1024 * 1024) {
      throw new BadRequestException('Image too large (max 8MB)');
    }

    let msg: any;
    try {
      msg = await this.bot.telegram.sendPhoto(
        adminChatId,
        { source: buf },
        { caption: `✅ banner uploaded${input.filename ? `: ${input.filename}` : ''}` },
      );
    } catch (e: any) {
      const desc = e?.response?.description || e?.message || String(e);
      this.logger.error(`sendPhoto failed: ${desc}`);
      throw new BadRequestException(`Telegram sendPhoto failed: ${desc}`);
    }

    const photos: any[] = msg?.photo || [];
    const best = photos[photos.length - 1];
    const fileId = best?.file_id;

    if (!fileId) {
      throw new BadRequestException('Could not extract file_id from Telegram response');
    }

    return {
      ok: true,
      fileId,
      width: best?.width,
      height: best?.height,
      fileSize: best?.file_size,
      messageId: msg?.message_id,
      chatId: msg?.chat?.id,
    };
  }

  /**
   * Broadcast photo + text to all users (anti-limit + block handling)
   */
  async broadcastBigTournamentOnce(params: {
    photo: string; // file_id OR https url
    botLink: string;
  }) {
    const caption = [
      '🏆 <b>Большой турнир уже в игре!</b>',
      '',
      '💰 Приз: <b>10 000 COIN</b> ~100$',
      '',
      '🔥 Чем больше очков — тем ближе победа.',
      '',
      '⏳ Успей принять участие до <b>1 марта</b>',
      '',
      '⚔️ Заходи в игру и докажи, что ты лучший охотник.',
      '',
      `👉 ${params.botLink}`,
    ].join('\n');

    const users = await this.prisma.user.findMany({
      where: {
        telegramId: { not: '' },
        isBlocked: false,
      },
      select: { id: true, telegramId: true },
      orderBy: { id: 'asc' },
    });

    if (!users.length) return { total: 0, sent: 0, failed: 0, blocked: 0 };

    let sent = 0;
    let failed = 0;
    let blocked = 0;

    for (const u of users) {
      const chatId = Number(u.telegramId);
      if (!Number.isFinite(chatId)) continue;

      try {
        await this.bot.telegram.sendPhoto(chatId, params.photo, {
          caption,
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔥 Играть сейчас', url: params.botLink }],
            ],
          },
        });

        sent++;
        await sleep(90); // ✅ safe speed
      } catch (e: any) {
        failed++;

        const desc =
          e?.response?.description ||
          e?.message ||
          String(e);

        // mark blocked
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

        // 429 retry
        const retryAfter = e?.response?.parameters?.retry_after;
        if (typeof retryAfter === 'number') {
          await sleep((retryAfter + 1) * 1000);
        } else {
          await sleep(150);
        }

        this.logger.warn(`Broadcast failed to ${u.telegramId}: ${desc}`);
      }
    }

    return { total: users.length, sent, failed, blocked };
  }
}