export class FinishGameDto {
  gameId: number;
  score: number;
  clicks: number;
  epicCount: number;
  melasCount?: number;

  rawTaps?: {
    at?: number;
    x?: number;
    y?: number;
    hit?: boolean;
    targetType?: string | null;
    spawnedAt?: number | null;
  }[];
}
