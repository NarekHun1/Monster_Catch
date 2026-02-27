import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { Readable } from 'node:stream';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type MulterFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

function stripDataUrl(base64: string) {
  const m = base64.match(/^data:([^;]+);base64,(.*)$/);
  if (m) return { mime: m[1], b64: m[2] };
  return { mime: undefined as string | undefined, b64: base64 };
}

@Injectable()
export class TournamentBroadcastService implements OnModuleInit {
  private readonly logger = new Logger(TournamentBroadcastService.name);

  // ✅ ТВОЙ ADMIN TG ID (хардкод)
  private readonly ADMIN_TG_ID = 934669069;

  constructor(
    private readonly prisma: PrismaService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  onModuleInit() {
    this.registerAdminFileIdListener();
    this.logger.log('✅ Admin file_id listener registered');
  }

  /**
   * ✅ Когда ADMIN отправляет боту фото -> бот отвечает file_id
   */
  private registerAdminFileIdListener() {
    this.bot.on('photo', async (ctx) => {
      try {
        const fromId = ctx.from?.id;
        if (!fromId || fromId !== this.ADMIN_TG_ID) return;

        const photos = (ctx.message as any)?.photo as any[] | undefined;
        if (!photos?.length) return;

        const best = photos[photos.length - 1];
        const fileId = best?.file_id;
        if (!fileId) return;

        await ctx.reply(
          `✅ file_id:\n<code>${fileId}</code>\n\n📐 ${best.width}x${best.height} | ${best.file_size ?? '-'} bytes`,
          { parse_mode: 'HTML' },
        );

        this.logger.log(`ADMIN photo received -> file_id=${fileId}`);
      } catch (e: any) {
        this.logger.error(
          `registerAdminFileIdListener error: ${e?.message || String(e)}`,
          e?.stack,
        );
      }
    });
  }

  /**
   * ✅ Upload photo (multipart/form-data) -> send to ADMIN -> return Telegram file_id
   */
  async photoUploadToTelegramFileId(file: MulterFile) {
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

    if (!buf?.length) throw new BadRequestException('Empty image buffer');

    if (buf.length > 8 * 1024 * 1024) {
      throw new BadRequestException('Image too large (max 8MB)');
    }

    let msg: any;

    try {
      msg = await this.bot.telegram.sendPhoto(
        adminChatId,
        { source: buf },
        {
          caption: `✅ banner uploaded${input.filename ? `: ${input.filename}` : ''}`,
        },
      );
    } catch (e: any) {
      const desc =
        e?.response?.description || e?.description || e?.message || String(e);
      this.logger.error(`❌ Telegram sendPhoto failed: ${desc}`, e?.stack);
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

      const isTelegramBlocked =
        String(desc).includes('bot was blocked') ||
        String(desc).includes('Forbidden: bot was blocked by the user') ||
        String(desc).includes('chat not found') ||
        String(desc).includes('user is deactivated');

      const retryAfter = e?.response?.parameters?.retry_after;

      return {
        ok: false as const,
        desc,
        isTelegramBlocked,
        retryAfter: typeof retryAfter === 'number' ? retryAfter : undefined,
      };
    }
  }

  /**
   * ✅ Помечаем пользователя как "недоступен в Telegram"
   * (НЕ бан, НЕ isBlocked)
   *
   * ⚠️ Если у тебя ещё нет полей telegramBlocked*, update упадёт.
   * Тогда мы просто логируем и продолжаем.
   */
  private async markTelegramBlocked(userId: number, reason: string) {
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          telegramBlocked: true as any,
          telegramBlockedAt: new Date() as any,
          telegramBlockedReason: reason.slice(0, 250) as any,
        },
      });
    } catch (e) {
      this.logger.warn(
        `markTelegramBlocked skipped (fields missing?) userId=${userId} reason=${reason}`,
      );
    }
  }

  /**
   * ✅ (Опционально) если захотишь "оживлять" юзера,
   * например когда он снова написал боту
   */
  private async unmarkTelegramBlocked(userId: number) {
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          telegramBlocked: false as any,
          telegramBlockedAt: null as any,
          telegramBlockedReason: null as any,
        },
      });
    } catch {}
  }

  /**
   * ✅ Broadcast photo + text to all users (one-time)
   * НЕ баним пользователей. Только помечаем telegramBlocked.
   */
  async broadcastBigTournamentOnce(params: { photo: string; botLink: string }) {
    const caption = [
      '🚨 <b>ФИНАЛ УЖЕ БЛИЗКО!</b>',
      '',
      '🏆 Большой турнир заканчивается через <b>2 ДНЯ</b>!',
      '',
      '💰 Приз: <b>10 000 COIN</b> (~100$)',
      '',
      '🔥 Сейчас решающие часы.',
      'Каждое очко может изменить таблицу лидеров.',
      '',
      '⏳ 1 марта — последний шанс ворваться в ТОП.',
      '',
      '⚔️ Если ты ещё не в игре — время пришло.',
      '',
      `👉 ${params.botLink}`,
    ].join('\n');

    const users = await this.prisma.user.findMany({
      where: {
        telegramId: { not: '' },
        isBlocked: false, // ✅ реальные баны
        telegramBlocked: false as any, // ✅ TG unreachable (если поля нет — всё равно ок)
      },
      select: { id: true, telegramId: true },
      orderBy: { id: 'asc' },
    });

    if (!users.length) {
      return {
        total: 0,
        sent: 0,
        failed: 0,
        telegramBlocked: 0,
        telegramBlockedIds: [] as number[],
        telegramBlockedTelegramIds: [] as string[],
        failSamples: [] as {
          userId: number;
          telegramId: string;
          desc: string;
        }[],
        aliveEstimate: 0,
      };
    }

    let sent = 0;
    let failed = 0;
    let telegramBlocked = 0;

    const telegramBlockedIds: number[] = [];
    const telegramBlockedTelegramIds: string[] = [];
    const failSamples: { userId: number; telegramId: string; desc: string }[] =
      [];

    for (const u of users) {
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
        await sleep(120);
        continue;
      }

      failed++;

      if (res.isTelegramBlocked) {
        telegramBlocked++;
        telegramBlockedIds.push(u.id);
        telegramBlockedTelegramIds.push(u.telegramId);

        await this.markTelegramBlocked(u.id, res.desc || 'telegram blocked');
      } else {
        if (failSamples.length < 30) {
          failSamples.push({
            userId: u.id,
            telegramId: u.telegramId,
            desc: res.desc,
          });
        }
      }

      if (typeof res.retryAfter === 'number') {
        await sleep((res.retryAfter + 1) * 1000);
      } else {
        await sleep(250);
      }

      this.logger.warn(`Broadcast failed to ${u.telegramId}: ${res.desc}`);
    }

    return {
      total: users.length,
      sent,
      failed,
      telegramBlocked,
      telegramBlockedIds,
      telegramBlockedTelegramIds,
      failSamples,
      aliveEstimate: users.length - telegramBlocked,
    };
  }

  /**
   * ✅ Broadcast only N users (test)
   */
  async broadcastBigTournamentToNOnce(params: {
    photo: string;
    botLink: string;
    limit: number;
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

    const where: any = {
      telegramId: { not: '' },
      isBlocked: false,
      telegramBlocked: false, // если поля нет — prisma может ругнуться в рантайме; см. ниже
    };
    if (params.userIds?.length) where.id = { in: params.userIds };

    let users: { id: number; telegramId: string }[] = [];

    // ✅ Чтобы не упасть если telegramBlocked ещё нет в БД — делаем try/catch
    try {
      users = await this.prisma.user.findMany({
        where,
        select: { id: true, telegramId: true },
        orderBy: { id: 'asc' },
        take: params.userIds?.length ? undefined : Math.max(1, params.limit),
      });
    } catch {
      // fallback: если полей telegramBlocked нет — шлём всем не-banned
      users = await this.prisma.user.findMany({
        where: {
          telegramId: { not: '' },
          isBlocked: false,
          ...(params.userIds?.length ? { id: { in: params.userIds } } : {}),
        },
        select: { id: true, telegramId: true },
        orderBy: { id: 'asc' },
        take: params.userIds?.length ? undefined : Math.max(1, params.limit),
      });
    }

    if (!users.length) {
      return {
        total: 0,
        sent: 0,
        failed: 0,
        telegramBlocked: 0,
        ids: [] as number[],
      };
    }

    let sent = 0;
    let failed = 0;
    let telegramBlocked = 0;
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
        await sleep(120);
        continue;
      }

      failed++;

      if (res.isTelegramBlocked) {
        telegramBlocked++;
        await this.markTelegramBlocked(u.id, res.desc || 'telegram blocked');
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

    return { total: users.length, sent, failed, telegramBlocked, ids };
  }
}
