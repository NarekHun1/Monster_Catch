// src/referral/referral.module.ts
import { Module } from '@nestjs/common';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';
import { PrismaModule } from '../src/prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '../src/auth/auth.module';

@Module({
  imports: [PrismaModule, ConfigModule, AuthModule],
  controllers: [ReferralController],
  providers: [ReferralService],
})
export class ReferralModule {}
