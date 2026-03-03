import { Module } from '@nestjs/common';
import { FusionController } from './fusion.controller';
import { FusionService } from './fusion.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [FusionController],
  providers: [FusionService],
})
export class FusionModule {}

