// src/payment/payment.module.ts
import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payments.controller';
import { PrismaModule } from '../src/prisma/prisma.module';
import { UserModule } from '../src/user/user.module';

@Module({
  imports: [PrismaModule, UserModule],
  providers: [PaymentService],
  controllers: [PaymentController],
  exports: [PaymentService],
})
export class PaymentModule {}
