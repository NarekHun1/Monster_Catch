import {
  Body,
  Controller,
  Headers,
  Post,
  UnauthorizedException,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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
   * Upload banner photo via Insomnia -> returns fileId
   * multipart/form-data: photo=file
   */
  @Post('upload-photo')
  @UseInterceptors(FileInterceptor('photo'))
  async uploadPhoto(
    @Headers('x-broadcast-secret') secret: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    this.guard(secret);
    return this.service.uploadPhotoAndGetFileId(file);
  }

  /**
   * Run one-time broadcast with photo+text
   * Body: { photo: "file_id or url", botLink: "https://t.me/monster_catch_bot" }
   */
  @Post('big-tournament-once')
  async bigTournamentOnce(
    @Headers('x-broadcast-secret') secret: string,
    @Body() body: { photo: string; botLink?: string },
  ) {
    this.guard(secret);

    const botLink = body.botLink || 'https://t.me/monster_catch_bot';
    return this.service.broadcastBigTournamentOnce({
      photo: body.photo,
      botLink,
    });
  }
}