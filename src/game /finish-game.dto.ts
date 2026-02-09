import { IsInt, Min } from 'class-validator';

export class FinishGameDto {
  @IsInt()
  @Min(1)
  gameId: number;

  @IsInt()
  @Min(0)
  score: number;

  @IsInt()
  @Min(0)
  clicks: number;

  @IsInt()
  @Min(0)
  epicCount: number;

  @IsInt()
  @Min(0)
  melasCount: number;
}
