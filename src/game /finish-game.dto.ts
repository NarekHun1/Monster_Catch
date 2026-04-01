import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class RawTapDto {
  @IsOptional()
  @IsNumber()
  at?: number;

  @IsOptional()
  @IsNumber()
  x?: number;

  @IsOptional()
  @IsNumber()
  y?: number;

  @IsOptional()
  @IsBoolean()
  hit?: boolean;

  @IsOptional()
  @IsString()
  targetType?: string | null;

  @IsOptional()
  @IsNumber()
  spawnedAt?: number | null;
}

export class FinishGameDto {
  @IsNumber()
  @Type(() => Number)
  gameId: number;

  @IsNumber()
  @Type(() => Number)
  score: number;

  @IsNumber()
  @Type(() => Number)
  clicks: number;

  @IsNumber()
  @Type(() => Number)
  epicCount: number;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  melasCount?: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RawTapDto)
  rawTaps?: RawTapDto[];
}