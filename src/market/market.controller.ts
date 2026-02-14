import { Body, Controller, Get, Headers, Post } from '@nestjs/common';
import { MarketService } from './market.service';

@Controller('market')
export class MarketController {
  constructor(private readonly service: MarketService) {}

  @Get('listings')
  getListings() {
    return this.service.getListings();
  }

  @Post('activate')
  activate(@Headers('authorization') auth: string) {
    return this.service.activate(auth);
  }

  @Post('list')
  list(
    @Headers('authorization') auth: string,
    @Body()
    body: { userMonsterId: number; price: number; currency: 'COINS' | 'STARS' },
  ) {
    return this.service.listFromFarm(auth, body);
  }

  @Post('buy')
  buy(
    @Headers('authorization') auth: string,
    @Body() body: { listingId: number },
  ) {
    return this.service.buy(auth, body.listingId);
  }

  @Post('cancel')
  cancel(
    @Headers('authorization') auth: string,
    @Body() body: { listingId: number },
  ) {
    return this.service.cancel(auth, body.listingId);
  }

  // очень советую добавить (для UI "Мои лоты")
  @Get('my')
  my(@Headers('authorization') auth: string) {
    return this.service.getMyListings(auth);
  }
}
