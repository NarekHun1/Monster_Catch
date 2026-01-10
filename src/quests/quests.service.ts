// src/quests/quests.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { TicketType, UserQuestStatus } from '@prisma/client';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';

@Injectable()
export class QuestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  private buildOpenUrl(q: {
    inviteLink?: string | null;
    chatUsername?: string | null;
  }): string | null {
    if (q.inviteLink) return q.inviteLink;
    if (q.chatUsername) {
      const uname = q.chatUsername.replace('@', '');
      return `https://t.me/${uname}`;
    }
    return null;
  }

  // ------------------------------
  // Список активных заданий + прогресс пользователя
  // ------------------------------
  async list(token: string) {
    const userId = this.auth.getUserIdFromToken(token);

    const quests = await this.prisma.quest.findMany({
      where: { isActive: true },
      orderBy: { id: 'desc' },
    });

    const progress = await this.prisma.userQuest.findMany({
      where: { userId },
      select: {
        questId: true,
        status: true,
        completedAt: true,
        claimedAt: true,
      },
    });

    const map = new Map(progress.map((p) => [p.questId, p]));

    return quests.map((q) => ({
      id: q.id,
      title: q.title,
      description: q.description,
      type: q.type,
      rewardTickets: q.rewardTickets,
      openUrl: this.buildOpenUrl(q),
      // иногда полезно фронту показать username
      chatUsername: q.chatUsername,
      progress: map.get(q.id) ?? null,
    }));
  }

  // ------------------------------
  // Verify: проверяем подписку на канал/чат
  // ------------------------------
  async verify(token: string, questId: number) {
    const userId = this.auth.getUserIdFromToken(token);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('USER_NOT_FOUND');

    const quest = await this.prisma.quest.findUnique({ where: { id: questId } });
    if (!quest || !quest.isActive) throw new BadRequestException('QUEST_NOT_FOUND');

    if (!quest.chatId && !quest.chatUsername)
      throw new BadRequestException('QUEST_CHAT_NOT_SET');

    // upsert прогресса
    const uq = await this.prisma.userQuest.upsert({
      where: { userId_questId: { userId, questId } },
      update: {},
      create: { userId, questId, status: UserQuestStatus.PENDING },
    });

    // если уже забрал — ничего не делаем
    if (uq.status === UserQuestStatus.CLAIMED) {
      return { status: uq.status };
    }

    // Telegram ID -> number
    const tgUserId = Number(user.telegramId);
    if (!Number.isFinite(tgUserId)) throw new BadRequestException('TELEGRAM_ID_INVALID');

    const chat = quest.chatId ?? quest.chatUsername!;

    try {
      const member = await this.bot.telegram.getChatMember(chat, tgUserId);

      const ok = ['creator', 'administrator', 'member'].includes(member.status);
      if (!ok) throw new BadRequestException('NOT_SUBSCRIBED');

      const updated = await this.prisma.userQuest.update({
        where: { id: uq.id },
        data: {
          status: UserQuestStatus.COMPLETED,
          completedAt: uq.completedAt ?? new Date(),
        },
      });

      return { status: updated.status };
    } catch (e) {
      // Часто бывает: бот не админ, чат приватный, chatId не тот, у канала нет доступа и т.д.
      // Чтобы не сливать детали наружу — возвращаем общий код
      throw new BadRequestException('SUBSCRIPTION_CHECK_FAILED');
    }
  }

  // ------------------------------
  // Claim: выдаем билеты (N штук), если verify уже прошел
  // ------------------------------
  async claim(token: string, questId: number) {
    const userId = this.auth.getUserIdFromToken(token);

    const quest = await this.prisma.quest.findUnique({ where: { id: questId } });
    if (!quest || !quest.isActive) throw new BadRequestException('QUEST_NOT_FOUND');

    const uq = await this.prisma.userQuest.findUnique({
      where: { userId_questId: { userId, questId } },
    });
    if (!uq) throw new BadRequestException('QUEST_NOT_VERIFIED');

    if (uq.status === UserQuestStatus.CLAIMED)
      throw new BadRequestException('ALREADY_CLAIMED');

    if (uq.status !== UserQuestStatus.COMPLETED)
      throw new BadRequestException('QUEST_NOT_COMPLETED');

    const reward = Math.max(1, Number(quest.rewardTickets ?? 1));

    await this.prisma.$transaction(async (tx) => {
      // ✅ быстро создаем N билетов одной операцией
      await tx.ticket.createMany({
        data: Array.from({ length: reward }, () => ({
          userId,
          type: TicketType.QUEST,
        })),
      });

      await tx.userQuest.update({
        where: { id: uq.id },
        data: {
          status: UserQuestStatus.CLAIMED,
          claimedAt: new Date(),
        },
      });
    });

    return {
      ok: true,
      rewardTickets: reward,
    };
  }

  // ------------------------------
  // (Опционально) Claim-одним-кликом: сам проверит подписку и выдаст
  // ------------------------------
  async claimWithVerify(token: string, questId: number) {
    // 1) verify
    const v = await this.verify(token, questId);

    // 2) если verify ок — claim
    if (v.status === UserQuestStatus.COMPLETED) {
      return this.claim(token, questId);
    }

    return { ok: false, status: v.status };
  }
}
