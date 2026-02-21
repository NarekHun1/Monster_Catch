import { IsString, IsOptional, IsIn } from 'class-validator';

export class JoinEventDto {
  @IsString()
  slug: string;

  // на будущее, но сейчас оставим только coins
  @IsOptional()
  @IsIn(['coins'])
  payWith?: 'coins';
}