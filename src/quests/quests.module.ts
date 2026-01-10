import { Module } from '@nestjs/common';
import { QuestsService } from './quests.service';
import { QuestsController } from './quests.controller';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';

@Module({
  controllers: [QuestsController],
  providers: [QuestsService, PrismaService, AuthService],
  exports: [QuestsService],
})
export class QuestsModule {}
