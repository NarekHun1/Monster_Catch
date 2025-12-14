import { Module } from '@nestjs/common';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  controllers: [TicketsController],
  providers: [TicketsService, PrismaService],
  imports: [AuthModule],})
export class TicketsModule {}
