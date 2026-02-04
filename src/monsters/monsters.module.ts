// src/monsters/monsters.module.ts
import { Module } from '@nestjs/common';
import { MonstersController } from './monsters.controller';
import { MonstersService } from './monsters.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [MonstersController],
  providers: [MonstersService],
  exports: [MonstersService],
})
export class MonstersModule {}
