import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RouletteController } from './roulette.controller';
import { RouletteService } from './roulette.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [RouletteController],
  providers: [RouletteService, PrismaService],
})
export class RouletteModule {}
