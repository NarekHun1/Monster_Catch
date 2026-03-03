import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { SummonService } from './summon.service';

type SummonMode = 'BASIC' | 'PREMIUM';

interface SummonPreviewDto {
  mode: SummonMode;
}

interface SummonExecuteDto extends SummonPreviewDto {}

@Controller('summon')
export class SummonController {
  constructor(private readonly summon: SummonService) {}

  @Get('state')
  getState(@Headers('authorization') auth: string) {
    return this.summon.getState(auth);
  }

  @Post('preview')
  preview(
    @Headers('authorization') auth: string,
    @Body() body: SummonPreviewDto,
  ) {
    return this.summon.preview(auth, body);
  }

  @Post('execute')
  execute(
    @Headers('authorization') auth: string,
    @Body() body: SummonExecuteDto,
  ) {
    return this.summon.execute(auth, body);
  }
}

