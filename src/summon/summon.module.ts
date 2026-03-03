import { Module } from '@nestjs/common';
import { SummonController } from './summon.controller';
import { SummonService } from './summon.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [SummonController],
  providers: [SummonService],
})
export class SummonModule {}

