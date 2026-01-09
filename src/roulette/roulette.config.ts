export type PrizeType = 'COINS' | 'TICKETS' | 'STARS' | 'NOTHING' | 'JACKPOT';

export type RouletteSector = {
  id: string;
  label: string;
  type: PrizeType;
  amount?: number;
  weight: number;
};

export const ROULETTE_SECTORS: RouletteSector[] = [
  { id: 'ticket_1', label: '🎟 +1', type: 'TICKETS', amount: 1, weight: 22 },
  { id: 'coins_10', label: '🪙 +10', type: 'COINS', amount: 10, weight: 22 },
  { id: 'coins_25', label: '🪙 +25', type: 'COINS', amount: 25, weight: 14 },
  { id: 'stars_5', label: '⭐ +5', type: 'STARS', amount: 5, weight: 10 },
  { id: 'ticket_3', label: '🎟 +3', type: 'TICKETS', amount: 3, weight: 10 },
  { id: 'stars_10', label: '⭐ +10', type: 'STARS', amount: 10, weight: 6 },
  {
    id: 'jackpot',
    label: '💥 JACKPOT',
    type: 'JACKPOT',
    amount: 100,
    weight: 1,
  },
  { id: 'nothing', label: '❌', type: 'NOTHING', weight: 15 },
];
