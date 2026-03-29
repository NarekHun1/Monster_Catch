// src/tournament/tournament.module.ts
import { Module } from '@nestjs/common';
import { TournamentService } from './tournament.service';
import { TournamentController } from './tournament.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { TournamentBroadcastService } from './tournament-broadcast.service';
import { TournamentBroadcastController } from './tournament-broadcast.controller';
import { PresenceService } from '../presence/presence.service';

@Module({
  imports: [PrismaModule, ConfigModule, PresenceService],
  providers: [TournamentService, TournamentBroadcastService],
  controllers: [TournamentController, TournamentBroadcastController],
})
export class TournamentModule {}
