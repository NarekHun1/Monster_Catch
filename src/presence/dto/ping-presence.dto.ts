import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class PingPresenceDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  screen?: string;

  @IsOptional()
  @IsBoolean()
  inGame?: boolean;
}