import {
  Controller,
  Post,
  Headers,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TournamentBroadcastService } from './tournament-broadcast.service';

@Controller('admin/broadcast')
export class TournamentBroadcastController {
  constructor(
    private readonly service: TournamentBroadcastService,
    private readonly config: ConfigService,
  ) {}

  @Post('invite-friends-once')
  async inviteFriendsOnce(@Headers('x-broadcast-secret') secret: string) {
    const expected = this.config.get<string>('BROADCAST_SECRET');

    if (!expected || secret !== expected) {
      throw new UnauthorizedException('Invalid secret');
    }

    return this.service.broadcastInviteFriendsOnce();
  }
}
