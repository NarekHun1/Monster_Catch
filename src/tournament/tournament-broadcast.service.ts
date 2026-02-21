import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { Readable } from 'node:stream';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function stripDataUrl(base64: string) {
  const m = base64.match(/^data:([^;]+);base64,(.*)$/);
  if (m) return { mime: m[1], b64: m[2] };
  return { mime: undefined as string | undefined, b64: base64 };
}

@Injectable()
export class TournamentBroadcastService {
  private readonly logger = new Logger(TournamentBroadcastService.name);

  // ✅ ТВОЙ ADMIN TG ID (хардкод)
  private readonly ADMIN_TG_ID = 934669069;

  constructor(
    private readonly prisma: PrismaService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  /**
   * ✅ Upload photo (multipart/form-data) -> send to ADMIN -> return Telegram file_id
   */
  async photoUploadToTelegramFileId(file: Express.Multer.File) {
    const adminChatId = this.ADMIN_TG_ID;
    if (!Number.isFinite(adminChatId)) {
      throw new BadRequestException('ADMIN_TG_ID must be a number');
    }

    this.logger.log(
      `📥 Upload received | name=${file.originalname} | mime=${file.mimetype} | size=${file.size}`,
    );

    if (!file.buffer?.length) throw new BadRequestException('Empty upload');
    if (file.size > 8 * 1024 * 1024)
      throw new BadRequestException('Image too large (max 8MB)');
    if (!file.mimetype?.startsWith('image/'))
      throw new BadRequestException('Invalid file type');

    const stream = Readable.from(file.buffer);

    let msg: any;
    try {
      this.logger.log('📤 Sending photo to Telegram (stream)...');

      msg = await this.bot.telegram.sendPhoto(
        adminChatId,
        {
          source: stream,
          filename: file.originalname || 'banner.jpg',
        },
        {
          caption: `✅ banner uploaded: ${file.originalname || 'banner'}`,
        },
      );

      this.logger.log('✅ Telegram sendPhoto success');
    } catch (e: any) {
      const desc = e?.response?.description || e?.message || String(e);
      this.logger.error(`❌ sendPhoto failed: ${desc}`, e?.stack);
      this.logger.error(
        `sendPhoto debug: ${JSON.stringify({
          code: e?.code,
          response: e?.response,
        })}`,
      );
      throw new BadRequestException(`Telegram sendPhoto failed: ${desc}`);
    }

    const photos: any[] = msg?.photo || [];
    const best = photos[photos.length - 1];
    const fileId = best?.file_id;

    if (!fileId) {
      this.logger.error(
        '❌ file_id not found in Telegram response',
        JSON.stringify(msg),
      );
      throw new BadRequestException(
        'Could not extract file_id from Telegram response',
      );
    }

    this.logger.log(`🎯 Extracted file_id: ${fileId}`);

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
   * ✅ Convert base64 -> Buffer -> send to ADMIN -> return Telegram file_id
   */
  async photoBase64ToTelegramFileId(input: {
    photoBase64: string;
    filename?: string;
  }) {
    this.logger.log('📥 photoBase64ToTelegramFileId called');

    const adminChatId = this.ADMIN_TG_ID;

    if (!Number.isFinite(adminChatId)) {
      this.logger.error(`❌ Invalid ADMIN_TG_ID: ${adminChatId}`);
      throw new BadRequestException('ADMIN_TG_ID must be a number');
    }

    this.logger.log(`📤 Sending photo to adminChatId: ${adminChatId}`);

    const { b64 } = stripDataUrl(input.photoBase64);

    let buf: Buffer;

    try {
      const cleaned = b64.replace(/\s+/g, '');
      buf = Buffer.from(cleaned, 'base64');

      this.logger.log(
        `🧾 Base64 decoded successfully | Size: ${buf.length} bytes`,
      );
    } catch (err) {
      this.logger.error('❌ Invalid base64 provided', err);
      throw new BadRequestException('Invalid base64');
    }

    if (!buf?.length) {
      this.logger.warn('⚠️ Empty image buffer');
      throw new BadRequestException('Empty image buffer');
    }

    if (buf.length > 8 * 1024 * 1024) {
      this.logger.warn(
        `⚠️ Image too large: ${buf.length} bytes (max 8MB allowed)`,
      );
      throw new BadRequestException('Image too large (max 8MB)');
    }

    let msg: any;

    try {
      this.logger.log('📤 Sending photo to Telegram...');
      msg = await this.bot.telegram.sendPhoto(
        adminChatId,
        { source: buf },
        {
          caption: `✅ banner uploaded${input.filename ? `: ${input.filename}` : ''}`,
        },
      );

      this.logger.log('✅ Telegram sendPhoto success');
    } catch (e: any) {
      this.logger.error(
        `❌ Telegram sendPhoto failed: ${e?.message || e?.description || String(e)}`,
        e?.stack,
      );

      const debug = {
        name: e?.name,
        message: e?.message,
        code: e?.code,
        status: e?.status,
        description: e?.response?.description ?? e?.description,
        response: e?.response,
        responseData: e?.response?.data,
        method: e?.method,
        cause: e?.cause
          ? {
              name: e.cause.name,
              message: e.cause.message,
              code: e.cause.code,
            }
          : undefined,
      };

      this.logger.error(`sendPhoto debug: ${JSON.stringify(debug)}`);

      const desc =
        e?.response?.description || e?.description || e?.message || String(e);
      throw new BadRequestException(`Telegram sendPhoto failed: ${desc}`);
    }

    const photos: any[] = msg?.photo || [];
    const best = photos[photos.length - 1];
    const fileId = best?.file_id;

    if (!fileId) {
      this.logger.error('❌ file_id not found in Telegram response', msg);
      throw new BadRequestException(
        'Could not extract file_id from Telegram response',
      );
    }

    this.logger.log(`🎯 Extracted file_id: ${fileId}`);
    this.logger.log(
      `📐 Image info | ${best?.width}x${best?.height} | ${best?.file_size} bytes`,
    );

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
   * ✅ Internal helper: send photo+caption to a chat with retry/blocked handling
   */
  private async safeSendPhoto(
    chatId: number,
    photo: string,
    caption: string,
    botLink: string,
  ) {
    try {
      await this.bot.telegram.sendPhoto(chatId, photo, {
        caption,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🔥 Играть сейчас', url: botLink }]],
        },
      });

      return { ok: true as const };
    } catch (e: any) {
      const desc = e?.response?.description || e?.message || String(e);

      const isBlocked =
        String(desc).includes('bot was blocked') ||
        String(desc).includes('chat not found') ||
        String(desc).includes('user is deactivated');

      const retryAfter = e?.response?.parameters?.retry_after;

      return {
        ok: false as const,
        desc,
        isBlocked,
        retryAfter: typeof retryAfter === 'number' ? retryAfter : undefined,
      };
    }
  }

  /**
   * ✅ Broadcast photo + text to all users (one-time)
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

        // ✅ безопасная задержка (чтобы не ловить 429)
        await sleep(120);
      } catch (e: any) {
        failed++;

        const desc = e?.response?.description || e?.message || String(e);

        // ✅ если user blocked / chat invalid — помечаем
        const isBlocked =
          String(desc).includes('bot was blocked') ||
          String(desc).includes('chat not found') ||
          String(desc).includes('user is deactivated');

        if (isBlocked) {
          blocked++;
          try {
            await this.prisma.user.update({
              where: { id: u.id },
              data: { isBlocked: true },
            });
          } catch {}
        }

        // ✅ rate limit (429)
        const retryAfter = e?.response?.parameters?.retry_after;
        if (typeof retryAfter === 'number') {
          this.logger.warn(`⏳ 429 retry_after=${retryAfter}s`);
          await sleep((retryAfter + 1) * 1000);
        } else {
          await sleep(250);
        }

        this.logger.warn(`Broadcast failed to ${u.telegramId}: ${desc}`);
      }
    }

    return { total: users.length, sent, failed, blocked };
  }
  /**
   * ✅ NEW: broadcast only N users one-time (for testing)
   * - if userIds provided: sends only to those users
   * - else: takes first N users by id asc
   */
  async broadcastBigTournamentToNOnce(params: {
    photo: string;
    botLink: string;
    limit: number; // e.g. 6
    userIds?: number[];
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

    const where: any = { telegramId: { not: '' }, isBlocked: false };

    if (params.userIds?.length) {
      where.id = { in: params.userIds };
    }

    const users = await this.prisma.user.findMany({
      where,
      select: { id: true, telegramId: true },
      orderBy: { id: 'asc' },
      take: params.userIds?.length ? undefined : Math.max(1, params.limit),
    });

    if (!users.length) {
      return { total: 0, sent: 0, failed: 0, blocked: 0, ids: [] as number[] };
    }

    let sent = 0;
    let failed = 0;
    let blocked = 0;

    const ids: number[] = [];

    for (const u of users) {
      ids.push(u.id);

      const chatId = Number(u.telegramId);
      if (!Number.isFinite(chatId)) continue;

      const res = await this.safeSendPhoto(
        chatId,
        params.photo,
        caption,
        params.botLink,
      );

      if (res.ok) {
        sent++;
        await sleep(120); // чуть медленнее, чтоб не ловить 429
        continue;
      }

      failed++;

      if (res.isBlocked) {
        blocked++;
        try {
          await this.prisma.user.update({
            where: { id: u.id },
            data: { isBlocked: true },
          });
        } catch {}
      }

      if (typeof res.retryAfter === 'number') {
        await sleep((res.retryAfter + 1) * 1000);
      } else {
        await sleep(250);
      }

      this.logger.warn(
        `Broadcast(ONLY-${params.limit}) failed to ${u.telegramId}: ${res.desc}`,
      );
    }

    return { total: users.length, sent, failed, blocked, ids };
  }
}
