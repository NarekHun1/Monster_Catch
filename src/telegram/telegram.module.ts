import { Module } from '@nestjs/common';
import { TelegrafModule } from 'nestjs-telegraf';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TelegramUpdate } from './telegram.update';
import { UserModule } from '../user/user.module';
import { TelegramWebappController } from './telegram-webapp.controller';
import { PaymentModule } from '../payments/payments.module';

@Module({
  imports: [
    UserModule,
    PaymentModule,
    ConfigModule,
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const token = config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');return { token };
      },
    }),
  ],
  providers: [TelegramUpdate],
  controllers: [TelegramWebappController],
})
export class TelegramModule {}
