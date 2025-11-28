import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { UserService } from '../src/user/user.service';
import { PrismaService } from '../src/prisma/prisma.service';

@Module({
  controllers: [PaymentsController],
  providers: [UserService, PrismaService],
})
export class PaymentsModule {}
