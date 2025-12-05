import { IsInt, IsString, Min, Length } from 'class-validator';

export class CreateWithdrawDto {
  @IsInt()
  @Min(50, { message: 'Минимум 50 монет для вывода' })
  coins: number;

  @IsString()
  network: string; // "TON", "TRC20", "BEP20"

  @IsString()
  @Length(10, 200, { message: 'Неверный адрес кошелька' })
  address: string;
}
