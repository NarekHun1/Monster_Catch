import { Controller, Get, Param, Post, Headers } from '@nestjs/common';
import { QuestsService } from './quests.service';

@Controller('quests')
export class QuestsController {
  constructor(private readonly quests: QuestsService) {}

  @Get()
  list(@Headers('authorization') auth: string) {
    return this.quests.list(auth);
  }

  @Post(':id/verify')
  verify(@Headers('authorization') auth: string, @Param('id') id: string) {
    return this.quests.verify(auth, Number(id));
  }

  @Post(':id/claim')
  claim(@Headers('authorization') auth: string, @Param('id') id: string) {
    return this.quests.claim(auth, Number(id));
  }
}
