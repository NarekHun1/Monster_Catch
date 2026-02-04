// src/monsters/monsters.controller.ts
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Post,
} from '@nestjs/common';
import { MonstersService } from './monsters.service';

@Controller('monsters')
export class MonstersController {
  constructor(private readonly monstersService: MonstersService) {}

  @Get('collection')
  getCollection(@Headers('authorization') auth?: string) {
    if (!auth) throw new BadRequestException('Missing Authorization header');
    return this.monstersService.getCollection(auth);
  }

  @Get('farm')
  getFarm(@Headers('authorization') auth?: string) {
    if (!auth) throw new BadRequestException('Missing Authorization header');
    return this.monstersService.getFarm(auth);
  }

  @Post('farm/unlock')
  unlock(
    @Headers('authorization') auth?: string,
    @Body() body?: { slotIndex?: number },
  ) {
    if (!auth) throw new BadRequestException('Missing Authorization header');
    if (!body?.slotIndex) throw new BadRequestException('slotIndex is required');
    return this.monstersService.unlockSlot(auth, body.slotIndex);
  }

  @Post('farm/assign')
  assign(
    @Headers('authorization') auth?: string,
    @Body() body?: { slotIndex?: number; userMonsterId?: number },
  ) {
    if (!auth) throw new BadRequestException('Missing Authorization header');
    if (!body?.slotIndex || !body?.userMonsterId) {
      throw new BadRequestException('slotIndex and userMonsterId are required');
    }
    return this.monstersService.assignToSlot(auth, body.slotIndex, body.userMonsterId);
  }

  @Post('farm/feed')
  feed(
    @Headers('authorization') auth?: string,
    @Body() body?: { slotIndex?: number },
  ) {
    if (!auth) throw new BadRequestException('Missing Authorization header');
    if (!body?.slotIndex) throw new BadRequestException('slotIndex is required');
    return this.monstersService.feed(auth, body.slotIndex);
  }

  // ⚠️ DEV ONLY
  @Post('dev/give')
  devGive(
    @Headers('authorization') auth?: string,
    @Body() body?: { key?: string; count?: number },
  ) {
    if (!auth) throw new BadRequestException('Missing Authorization header');
    if (!body?.key) throw new BadRequestException('key is required');
    return this.monstersService.devGiveMonster(auth, body.key, body.count ?? 1);
  }
}
