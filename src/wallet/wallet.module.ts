import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthModule } from '../auth/auth.module';
import { TonService } from './ton.service';
import { AuthService } from '../auth/auth.service';

@Module({
  imports: [AuthModule],
  controllers: [WalletController],
  providers: [WalletService, PrismaService, TonService, AuthService],
})
export class WalletModule {}
