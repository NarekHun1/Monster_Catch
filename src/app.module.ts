import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ServeStaticModule } from '@nestjs/serve-static';
import { PrismaModule } from './prisma/prisma.module';
import { UserModule } from './user/user.module';
import { TelegramModule } from './telegram/telegram.module';
import { AuthModule } from './auth/auth.module';
import { GameModule } from './game /game.module';
import { ShopModule } from './shop/shop.module';
import { ReferralModule } from '../referal/referral.module';
import { DailyQuestsBroadcastModule } from './daily-quests/daily-quests-broadcast.module';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ServeStaticModule.forRoot({
      rootPath: '/Users/narek/WebstormProjects/MonsterCatch/webapp/dist', // 👈 твой dist
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    UserModule,
    TelegramModule,
    AuthModule,
    GameModule,
    ShopModule,
    ReferralModule,
    DailyQuestsBroadcastModule,
  ],
})
export class AppModule {}
