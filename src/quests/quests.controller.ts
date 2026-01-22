import { Controller, Get, Param, Post, Headers } from '@nestjs/common';
import { QuestsService } from './quests.service';

@Controller('quests')
export class QuestsController {
  constructor(private readonly quests: QuestsService) {}

  private getToken(auth?: string) {
    if (!auth) return '';
    return auth.startsWith('Bearer ') ? auth.slice(7) : auth;
  }

  @Get()
  list(@Headers('authorization') auth: string) {
    return this.quests.list(this.getToken(auth));
  }

  // ✅ NEW: фиксируем openedAt (нужно для Instagram verify)
  @Post(':id/open')
  open(@Headers('authorization') auth: string, @Param('id') id: string) {
    return this.quests.open(this.getToken(auth), Number(id));
  }

  @Post(':id/verify')
  verify(@Headers('authorization') auth: string, @Param('id') id: string) {
    return this.quests.verify(this.getToken(auth), Number(id));
  }

  @Post(':id/claim')
  claim(@Headers('authorization') auth: string, @Param('id') id: string) {
    return this.quests.claim(this.getToken(auth), Number(id));
  }

  // (опционально) если захочешь "одной кнопкой":
  // @Post(':id/claim-with-verify')
  // claimWithVerify(@Headers('authorization') auth: string, @Param('id') id: string) {
  //   return this.quests.claimWithVerify(this.getToken(auth), Number(id));
  // }
}
