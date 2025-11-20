// src/auth/auth.controller.ts
import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('telegram')
  async telegramAuth(@Body() body: any) {
    console.log('--- /auth/telegram BODY ---', body);
    return this.auth.login(body?.initData);
  }
}
