import {
  Controller,
  Get,
  Headers,
  Post,
  BadRequestException,
} from '@nestjs/common';
import { UserService } from './user.service';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import { User } from '@prisma/client';

interface JwtPayload {
  userId: number;
}

@Controller('users')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly config: ConfigService,
  ) {}

  private getUserIdFromToken(authHeader?: string): number {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Missing or invalid Authorization header');
    }
    const token = authHeader.slice(7);
    const secret = this.config.get<string>('JWT_SECRET');
    const payload = jwt.verify(token, secret!) as JwtPayload;
    return payload.userId;
  }

  @Get('me')
  async me(@Headers('authorization') authHeader?: string) {
    const userId = this.getUserIdFromToken(authHeader);
    const user = await this.userService.findById(userId);

    if (!user) {
      throw new BadRequestException('User not found');
    }

    return {
      id: user.id,
      username: user.username,
      firstName: user.firstName,
      stars: user.stars,
      multiplierLevel: user.multiplierLevel,
      extraTimeLevel: user.extraTimeLevel,
      epicBoostLevel: user.epicBoostLevel,
      level: user.level,
      xp: user.xp,
    };
  }

  @Get()
  async getUsers(): Promise<User[]> {
    return this.userService.findAll();
  }
}
