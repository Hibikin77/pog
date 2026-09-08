const extractRaceId = (url: string) => {
  // 結果ページの URL（.../race/result.html?race_id=xxx）は race_id パラメータを優先する。
  // パスから取る時は /race/result.html を ID と誤認しないよう12桁に限定する
  const raceIdParam = url.match(/[?&]race_id=([0-9a-zA-Z]{12})/)?.[1];
  if (raceIdParam) {
    return raceIdParam;
  }

  return url.match(/\/race\/([0-9a-zA-Z]{12})(?:\/|$)/)?.[1] ?? null;
};

let disconnectPrisma: (() => Promise<void>) | null = null;

const main = async () => {
  const { default: prisma } = await import("../src/lib/prisma");
  disconnectPrisma = () => prisma.$disconnect();
  const races = await prisma.race.findMany({
    where: {
      raceId: null,
    },
    select: {
      id: true,
      url: true,
    },
  });

  let updatedCount = 0;
  let skippedCount = 0;

  for (const race of races) {
    const raceId = extractRaceId(race.url);

    if (!raceId) {
      skippedCount++;
      console.log(`skipped: race id not found in url: ${race.id} ${race.url}`);
      continue;
    }

    await prisma.race.update({
      where: {
        id: race.id,
      },
      data: {
        raceId,
      },
    });
    updatedCount++;
  }

  console.log(`updated races: ${updatedCount}`);
  console.log(`skipped races: ${skippedCount}`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (disconnectPrisma) {
      await disconnectPrisma();
    }
  });
