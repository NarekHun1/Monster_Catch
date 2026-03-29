import { Module } from '@nestjs/common';
import { TournamentService } from './tournament.service';
import { TournamentController } from './tournament.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { TournamentBroadcastService } from './tournament-broadcast.service';
import { TournamentBroadcastController } from './tournament-broadcast.controller';
import { PresenceModule } from '../presence/presence.module';

@Module({
  imports: [PrismaModule, ConfigModule, PresenceModule],
  providers: [TournamentService, TournamentBroadcastService],
  controllers: [TournamentController, TournamentBroadcastController],
})
export class TournamentModule {}