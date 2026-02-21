import { IsInt, IsPositive, IsString } from 'class-validator';

export class SubmitScoreDto {
  @IsString()
  slug: string;

  @IsInt()
  @IsPositive()
  score: number;
}
