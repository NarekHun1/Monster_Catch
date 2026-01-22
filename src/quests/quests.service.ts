// src/quests/quests.service.ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { QuestType, TicketType, UserQuestStatus } from '@prisma/client';
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
    type: QuestType;
    openUrl?: string | null;
    inviteLink?: string | null;
    chatUsername?: string | null;
  }): string | null {
    // ✅ если задано openUrl — используем его (Instagram/любой URL)
    if (q.openUrl) return q.openUrl;

    // ✅ старое поведение для SUBSCRIBE
    if (q.type === QuestType.SUBSCRIBE) {
      if (q.inviteLink) return q.inviteLink;
      if (q.chatUsername) {
        const uname = q.chatUsername.replace('@', '');
        return `https://t.me/${uname}`;
      }
    }

    return null;
  }

  // ------------------------------
  // Список активных заданий + прогресс пользователя
  // ✅ CLAIMED скрываем (задание исчезает)
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
        openedAt: true,
        completedAt: true,
        claimedAt: true,
      },
    });

    const map = new Map(progress.map((p) => [p.questId, p]));

    // ✅ фильтруем CLAIMED: если уже получил — не показываем
    return quests
      .filter((q) => {
        const p = map.get(q.id);
        return p?.status !== UserQuestStatus.CLAIMED;
      })
      .map((q) => ({
        id: q.id,
        title: q.title,
        description: q.description,
        type: q.type,
        rewardTickets: q.rewardTickets,
        openUrl: this.buildOpenUrl(q),
        chatUsername: q.chatUsername,
        progress: map.get(q.id) ?? null,
      }));
  }

  // ------------------------------
  // Open: фиксируем, что юзер нажал "Выполнить"
  // (для Instagram — обязательно, чтобы verify работал честнее)
  // ------------------------------
  async open(token: string, questId: number) {
    const userId = this.auth.getUserIdFromToken(token);

    const quest = await this.prisma.quest.findUnique({ where: { id: questId } });
    if (!quest || !quest.isActive) throw new BadRequestException('QUEST_NOT_FOUND');

    const uq = await this.prisma.userQuest.upsert({
      where: { userId_questId: { userId, questId } },
      update: {
        // если уже COMPLETED/CLAIMED — не трогаем
        openedAt: new Date(),
      },
      create: {
        userId,
        questId,
        status: UserQuestStatus.PENDING,
        openedAt: new Date(),
      },
    });

    return { ok: true, status: uq.status };
  }

  // ------------------------------
  // Verify:
  // 1) SUBSCRIBE — проверяем подписку через getChatMember (как у тебя было)
  // 2) INSTAGRAM_FOLLOW — MVP: open -> wait 12 sec -> COMPLETED
  // ------------------------------
  async verify(token: string, questId: number) {
    const userId = this.auth.getUserIdFromToken(token);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('USER_NOT_FOUND');

    const quest = await this.prisma.quest.findUnique({ where: { id: questId } });
    if (!quest || !quest.isActive) throw new BadRequestException('QUEST_NOT_FOUND');

    const uq = await this.prisma.userQuest.upsert({
      where: { userId_questId: { userId, questId } },
      update: {},
      create: { userId, questId, status: UserQuestStatus.PENDING },
    });

    if (uq.status === UserQuestStatus.CLAIMED) {
      return { status: uq.status };
    }

    // ✅ INSTAGRAM
    if (quest.type === QuestType.INSTAGRAM_FOLLOW) {
      // нужно чтобы open был нажат
      if (!uq.openedAt) throw new BadRequestException('OPEN_INSTAGRAM_FIRST');

      const ms = Date.now() - new Date(uq.openedAt).getTime();
      if (ms < 12_000) throw new BadRequestException('WAIT_A_BIT');

      const updated = await this.prisma.userQuest.update({
        where: { id: uq.id },
        data: {
          status: UserQuestStatus.COMPLETED,
          completedAt: uq.completedAt ?? new Date(),
        },
      });

      return { status: updated.status };
    }

    // ✅ TELEGRAM SUBSCRIBE
    if (quest.type === QuestType.SUBSCRIBE) {
      if (!quest.chatId && !quest.chatUsername) {
        throw new BadRequestException('QUEST_CHAT_NOT_SET');
      }

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
        throw new BadRequestException('SUBSCRIPTION_CHECK_FAILED');
      }
    }

    throw new BadRequestException('QUEST_TYPE_NOT_SUPPORTED');
  }

  // ------------------------------
  // Claim: выдаем билеты (N штук)
  // После CLAIM — list() уже НЕ вернет этот квест -> "исчезнет"
  // ------------------------------
  async claim(token: string, questId: number) {
    const userId = this.auth.getUserIdFromToken(token);

    const quest = await this.prisma.quest.findUnique({ where: { id: questId } });
    if (!quest || !quest.isActive) throw new BadRequestException('QUEST_NOT_FOUND');

    const uq = await this.prisma.userQuest.findUnique({
      where: { userId_questId: { userId, questId } },
    });
    if (!uq) throw new BadRequestException('QUEST_NOT_VERIFIED');

    if (uq.status === UserQuestStatus.CLAIMED) throw new BadRequestException('ALREADY_CLAIMED');
    if (uq.status !== UserQuestStatus.COMPLETED) throw new BadRequestException('QUEST_NOT_COMPLETED');

    const reward = Math.max(1, Number(quest.rewardTickets ?? 1));

    await this.prisma.$transaction(async (tx) => {
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

    return { ok: true, rewardTickets: reward };
  }

  async claimWithVerify(token: string, questId: number) {
    const v = await this.verify(token, questId);
    if (v.status === UserQuestStatus.COMPLETED) return this.claim(token, questId);
    return { ok: false, status: v.status };
  }
}
