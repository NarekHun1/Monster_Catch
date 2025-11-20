import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { ShopService } from './shop.service';

@Controller('shop')
export class ShopController {
  constructor(private readonly shopService: ShopService) {}

  @Get('status')
  async status(@Headers('authorization') authHeader?: string) {
    return this.shopService.getStatus(authHeader);
  }

  @Post('buy')
  async buy(
    @Headers('authorization') authHeader?: string,
    @Body() body?: { itemId: 'multiplier' | 'extra_time' | 'epic_boost' },
  ) {
    return this.shopService.buy(authHeader, body?.itemId as any);
  }
}
