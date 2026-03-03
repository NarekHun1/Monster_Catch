import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { FusionService } from './fusion.service';

type FusionMode = 'STANDARD' | 'CATALYST' | 'PREMIUM';

interface FusionPreviewDto {
  mode: FusionMode;
  userMonsterIds: number[];
  tokenId?: number | null;
  useProtection?: boolean;
}

interface FusionExecuteDto extends FusionPreviewDto {}

@Controller('fusion')
export class FusionController {
  constructor(private readonly fusion: FusionService) {}

  @Get('tokens')
  getTokens(@Headers('authorization') auth: string) {
    return this.fusion.getTokens(auth);
  }

  @Post('preview')
  preview(
    @Headers('authorization') auth: string,
    @Body() body: FusionPreviewDto,
  ) {
    return this.fusion.preview(auth, body);
  }

  @Post('execute')
  execute(
    @Headers('authorization') auth: string,
    @Body() body: FusionExecuteDto,
  ) {
    return this.fusion.execute(auth, body);
  }
}

