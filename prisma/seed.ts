import { PrismaClient, MonsterRarity } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const defs = [
    {
      key: 'DEMON',
      name: 'Demon',
      rarity: MonsterRarity.COMMON,
      imgUrl: 'https://placehold.co/120x120/png?text=DEMON',
    },
    {
      key: 'CLOVER',
      name: 'Clover',
      rarity: MonsterRarity.RARE,
      imgUrl: 'https://placehold.co/120x120/png?text=CLOVER',
    },
    {
      key: 'FIRE',
      name: 'Fire',
      rarity: MonsterRarity.EPIC,
      imgUrl: 'https://placehold.co/120x120/png?text=FIRE',
    },
    {
      key: 'DRAGON',
      name: 'Dragon',
      rarity: MonsterRarity.LEGENDARY,
      imgUrl: 'https://placehold.co/120x120/png?text=DRAGON',
    },
    {
      key: 'GEM',
      name: 'Gem',
      rarity: MonsterRarity.COMMON,
      imgUrl: 'https://placehold.co/120x120/png?text=GEM',
    },
  ];

  for (const d of defs) {
    await prisma.monsterDef.upsert({
      where: { key: d.key },
      create: d,
      update: {
        name: d.name,
        rarity: d.rarity,
        imgUrl: d.imgUrl,
        isActive: true,
      },
    });
  }

  console.log('✅ MonsterDef seeded');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
