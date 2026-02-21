import { Module } from '@nestjs/common';
import { EventTournamentController } from './event-tournament.controller';
import { EventTournamentService } from './event-tournament.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

@Module({
  controllers: [EventTournamentController],
  providers: [EventTournamentService, PrismaService, ConfigService],
  exports: [EventTournamentService],
})
export class EventTournamentModule {}