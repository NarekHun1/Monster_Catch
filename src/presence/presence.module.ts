import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PresenceController } from './presence.controller';
import { PresenceService } from './presence.service';

@Module({
  imports: [ConfigModule],
  controllers: [PresenceController],
  providers: [PresenceService, PrismaService],
  exports: [PresenceService],
})
export class PresenceModule {}