import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
  BadRequestException,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TournamentBroadcastService } from './tournament-broadcast.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';

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
   * ✅ base64 -> Telegram file_id
   */
  @Post('photo-to-fileid')
  async photoToFileId(
    @Headers('x-broadcast-secret') secret: string,
    @Body() body: { photoBase64: string; filename?: string },
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
   * ✅ multipart upload -> Telegram file_id
   * form-data: photo=<file>
   */
  @Post('upload-banner')
  @UseInterceptors(
    FileInterceptor('photo', {
      storage: memoryStorage(),
      limits: { fileSize: 8 * 1024 * 1024 },
      fileFilter: (req, file, cb) => {
        if (!file.mimetype?.startsWith('image/')) {
          return cb(new BadRequestException('Only image files are allowed'), false);
        }
        cb(null, true);
      },
    }),
  )
  async uploadBanner(@UploadedFile() file?: any) {
    if (!file) throw new BadRequestException('photo is required');
    return this.service.photoUploadToTelegramFileId(file);
  }

  /**
   * ✅ broadcast to ALL users
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

  /**
   * ✅ broadcast only N users (test)
   */
  @Post('big-tournament-test')
  async bigTournamentTest(
    @Headers('x-broadcast-secret') secret: string,
    @Body()
    body: {
      photo: string;
      botLink?: string;
      limit?: number;
      userIds?: number[];
    },
  ) {
    this.guard(secret);

    if (!body?.photo) {
      throw new BadRequestException('photo is required (file_id or https url)');
    }

    const limit = Number.isFinite(body.limit as number) ? Number(body.limit) : 6;

    return this.service.broadcastBigTournamentToNOnce({
      photo: body.photo,
      botLink: body.botLink || 'https://t.me/monster_catch_bot',
      limit,
      userIds:
        Array.isArray(body.userIds) && body.userIds.length ? body.userIds : undefined,
    });
  }
}