// src/game/game.module.ts
import { Module } from '@nestjs/common';
import { GameController } from './game.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { GameService } from './game.service';
import { NotificationService } from '../notification/notification.service';

@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [GameController],
  providers: [GameService, NotificationService],
})
export class GameModule {}
