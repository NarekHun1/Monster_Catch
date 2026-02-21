import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TournamentBroadcastService } from './tournament-broadcast.service';

@Controller('admin/broadcast')
export class TournamentBroadcastController {
  constructor(
    private readonly service: TournamentBroadcastService,
    private readonly config: ConfigService,
  ) {}

  private guard(secret: string) {
    const expected = this.config.get<string>('BROADCAST_SECRET');
    if (!expected || secret !== expected) {
      throw new UnauthorizedException('Invalid secret');
    }
  }

  /**
   * ✅ Upload photo WITHOUT multer:
   * Send base64 in JSON -> returns Telegram file_id
   *
   * Body:
   * {
   *   "photoBase64": "data:image/png;base64,...." OR "....",
   *   "filename": "banner.png" (optional)
   * }
   */
  @Post('photo-to-fileid')
  async photoToFileId(
    @Headers('x-broadcast-secret') secret: string,
    @Body()
    body: {
      photoBase64: string;
      filename?: string;
    },
  ) {
    this.guard(secret);

    if (!body?.photoBase64) {
      throw new BadRequestException('photoBase64 is required');
    }

    return this.service.photoBase64ToTelegramFileId({
      photoBase64: body.photoBase64,
      filename: body.filename,
    });
  }

  /**
   * ✅ One-time broadcast to all users:
   * Body:
   * {
   *   "photo": "AgAC...file_id..." OR "https://...jpg",
   *   "botLink": "https://t.me/monster_catch_bot" (optional)
   * }
   */
  @Post('big-tournament-once')
  async bigTournamentOnce(
    @Headers('x-broadcast-secret') secret: string,
    @Body() body: { photo: string; botLink?: string },
  ) {
    this.guard(secret);

    if (!body?.photo) {
      throw new BadRequestException('photo is required (file_id or https url)');
    }

    return this.service.broadcastBigTournamentOnce({
      photo: body.photo,
      botLink: body.botLink || 'https://t.me/monster_catch_bot',
    });
  }
}
