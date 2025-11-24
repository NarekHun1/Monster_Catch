// src/tournament/tournament.module.ts
import { Module } from '@nestjs/common';
import { TournamentService } from './tournament.service';
import { TournamentController } from './tournament.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { TournamentBroadcastService } from './tournament-broadcast.service';

@Module({
  imports: [PrismaModule, ConfigModule],
  providers: [TournamentService, TournamentBroadcastService],
  controllers: [TournamentController],
})
export class TournamentModule {}
