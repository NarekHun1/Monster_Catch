import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { PresenceService } from './presence.service';
import { PingPresenceDto } from './dto/ping-presence.dto';

interface JwtPayload {
  userId: number;
}

@Controller('presence')
export class PresenceController {
  constructor(
    private readonly presenceService: PresenceService,
    private readonly config: ConfigService,
  ) {}

  private getUserIdFromAuthHeader(authHeader?: string): number {
    if (!authHeader) throw new UnauthorizedException('Authorization header missing');

    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    if (!token) throw new UnauthorizedException('Token missing');

    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret) throw new UnauthorizedException('JWT secret missing');

    try {
      const payload = jwt.verify(token, secret) as JwtPayload;
      return payload.userId;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }

  @Post('ping')
  async ping(
    @Headers('authorization') authorization: string,
    @Body() dto: PingPresenceDto,
  ) {
    const userId = this.getUserIdFromAuthHeader(authorization);

    await this.presenceService.ping(
      userId,
      dto.screen,
      dto.inGame ?? false,
    );

    return {
      success: true,
      online: true,
      screen: dto.screen ?? null,
      inGame: dto.inGame ?? false,
      ts: new Date(),
    };
  }
}