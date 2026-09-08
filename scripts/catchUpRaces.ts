import {
  fetchHorseRaceHistory,
  getHorseBirthYear,
  type HorseRaceHistoryItem,
} from "./lib/horseRaceHistory";
import { NetkeibaBlockedError, sleep } from "./lib/netkeibaFetch";
import { extractHorseExternalId, fetchRaceResult, getPoint, getRaceSource } from "./lib/raceResult";
import { getOwnerRevalidatePaths, postRevalidate } from "./lib/revalidate";

// 週次のキャッチアップ:
// アクティブ全馬の競走成績ページ（db.netkeiba）を見て、まだ Race に無いレースを JRA・地方の結果ページから登録する。
// 土日の出走予定ベースの更新で拾えない地方（平日・ナイター）や祝日開催の取りこぼしを埋める役

type CliOptions = {
  dryRun: boolean;
  horseIds: number[];
  horseExternalIds: string[];
  since: string | null;
  maxHorses: number | null;
  maxRaces: number | null;
};

type TargetHorse = {
  id: number;
  name: string;
  url: string;
  owners: {
    id: number;
    seasonId: number;
    ruleId: number;
  }[];
};

type RaceTarget = {
  horse: TargetHorse;
  horseExternalId: string;
  history: HorseRaceHistoryItem;
};

const HORSE_REQUEST_INTERVAL_MS = 1000;
const RACE_REQUEST_INTERVAL_MS = 500;
let disconnectPrisma: (() => Promise<void>) | null = null;

const parseCsvOption = (value: string | undefined) => {
  return value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    : [];
};

const parseArgs = (argv: string[]): CliOptions => {
  const options: CliOptions = {
    dryRun: false,
    horseIds: [],
    horseExternalIds: [],
    since: null,
    maxHorses: null,
    maxRaces: null,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    const [key, value] = arg.split("=");

    switch (key) {
      case "--horse-ids":
        options.horseIds.push(
          ...parseCsvOption(value)
            .map((id) => Number.parseInt(id, 10))
            .filter((id) => !Number.isNaN(id))
        );
        break;
      case "--horse-external-ids":
        options.horseExternalIds.push(...parseCsvOption(value));
        break;
      case "--horse-urls":
        options.horseExternalIds.push(
          ...parseCsvOption(value).flatMap((url) => {
            const externalId = extractHorseExternalId(url);
            return externalId ? [externalId] : [];
          })
        );
        break;
      case "--since":
        if (value && !/^\d{8}$/.test(value)) {
          throw new Error(`invalid --since (expected YYYYMMDD): ${value}`);
        }
        options.since = value ?? null;
        break;
      case "--max-horses":
        options.maxHorses = value ? Number.parseInt(value, 10) : null;
        break;
      case "--max-races":
        options.maxRaces = value ? Number.parseInt(value, 10) : null;
        break;
    }
  }

  options.horseIds = [...new Set(options.horseIds)];
  options.horseExternalIds = [...new Set(options.horseExternalIds)];

  // 馬IDを直接指定した時は DB を使わない（ローカル検証用）ので必ず dry run
  if (options.horseExternalIds.length > 0) {
    options.dryRun = true;
  }

  return options;
};

// POG 期間の始まりは「2歳の4月1日」。地方の2歳戦は4月から始まるのでそこまで含める
const getDefaultSince = (externalId: string) => {
  const birthYear = getHorseBirthYear(externalId);
  return birthYear === null ? null : `${birthYear + 2}0401`;
};

const getDryRunHorses = (horseExternalIds: string[]): TargetHorse[] => {
  return horseExternalIds.map((externalId, index) => ({
    id: index + 1,
    name: `dry-run-${externalId}`,
    url: `https://db.netkeiba.com/horse/${externalId}/`,
    owners: [],
  }));
};

const getActiveHorses = async (options: CliOptions): Promise<TargetHorse[]> => {
  if (options.horseExternalIds.length > 0) {
    return getDryRunHorses(options.horseExternalIds);
  }

  const { default: prisma } = await import("../src/lib/prisma");
  disconnectPrisma = () => prisma.$disconnect();

  return prisma.horse.findMany({
    where: {
      ...(options.horseIds.length > 0 ? { id: { in: options.horseIds } } : {}),
      owners: {
        some: {
          season: {
            isActive: true,
          },
        },
      },
    },
    select: {
      id: true,
      name: true,
      url: true,
      owners: {
        where: {
          season: {
            isActive: true,
          },
        },
        select: {
          id: true,
          seasonId: true,
          ruleId: true,
        },
      },
    },
    orderBy: {
      id: "asc",
    },
  });
};

const getExistingRaceKeys = async (options: CliOptions, horseIds: number[]) => {
  if (options.horseExternalIds.length > 0 || horseIds.length === 0) {
    return new Set<string>();
  }

  const { default: prisma } = await import("../src/lib/prisma");
  const races = await prisma.race.findMany({
    where: {
      horseId: {
        in: horseIds,
      },
    },
    select: {
      horseId: true,
      raceId: true,
    },
  });

  return new Set(races.map((race) => `${race.horseId}:${race.raceId}`));
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  console.log(`dry run: ${options.dryRun}`);
  console.log(`since: ${options.since ?? "(April 1 of each horse's 2yo year)"}`);

  const allHorses = await getActiveHorses(options);
  const horses = options.maxHorses === null ? allHorses : allHorses.slice(0, options.maxHorses);
  console.log(`target horses: ${horses.length}`);

  const existingRaceKeys = await getExistingRaceKeys(
    options,
    horses.map((horse) => horse.id)
  );

  const targetsByRaceId = new Map<string, RaceTarget[]>();
  const failedHorseIds: number[] = [];
  let skippedOverseasCount = 0;
  let skippedNoResultCount = 0;
  let historyCount = 0;

  for (const horse of horses) {
    const externalId = extractHorseExternalId(horse.url);
    const since = options.since ?? (externalId ? getDefaultSince(externalId) : null);

    if (!externalId || !/^\d+$/.test(externalId) || !since) {
      console.log(`skipped: horse ${horse.id} ${horse.name} has invalid url: ${horse.url}`);
      failedHorseIds.push(horse.id);
      continue;
    }

    try {
      const history = await fetchHorseRaceHistory(externalId);
      const targetHistory = history.filter((item) => item.date >= since);
      historyCount += targetHistory.length;

      for (const item of targetHistory) {
        if (!getRaceSource(item.raceId)) {
          skippedOverseasCount++;
          console.log(
            `skipped overseas race: ${item.date} ${item.raceName} (${item.raceId}) - ${horse.name}`
          );
          continue;
        }

        // 取消・除外などは結果ページに着順が無いので対象外
        if (!/^\d+/.test(item.resultText)) {
          skippedNoResultCount++;
          continue;
        }

        if (existingRaceKeys.has(`${horse.id}:${item.raceId}`)) {
          continue;
        }

        const targets = targetsByRaceId.get(item.raceId) ?? [];
        targets.push({ horse, horseExternalId: externalId, history: item });
        targetsByRaceId.set(item.raceId, targets);
      }
    } catch (error) {
      if (error instanceof NetkeibaBlockedError) {
        throw error;
      }

      failedHorseIds.push(horse.id);
      console.error(`failed to fetch horse history: ${horse.id} ${horse.name}`);
      console.error(error);
    }

    await sleep(HORSE_REQUEST_INTERVAL_MS);
  }

  const raceIds = [...targetsByRaceId.entries()]
    .sort(([, a], [, b]) => a[0].history.date.localeCompare(b[0].history.date))
    .map(([raceId]) => raceId);
  const targetRaceIds = options.maxRaces === null ? raceIds : raceIds.slice(0, options.maxRaces);

  console.log(`history rows in period: ${historyCount}`);
  console.log(`skipped overseas races: ${skippedOverseasCount}`);
  console.log(`skipped races without result: ${skippedNoResultCount}`);
  console.log(
    `unregistered targets: ${[...targetsByRaceId.values()].reduce(
      (sum, targets) => sum + targets.length,
      0
    )}`
  );
  console.log(`target races: ${targetRaceIds.length}`);

  const failedRaceIds: string[] = [];
  const revalidatePaths: string[] = [];
  let createdCount = 0;

  for (const raceId of targetRaceIds) {
    const raceTargets = targetsByRaceId.get(raceId) ?? [];

    try {
      const raceResult = await fetchRaceResult(raceId);
      const entryByExternalId = new Map(
        raceResult.entries.map((entry) => [entry.horseExternalId, entry])
      );

      for (const target of raceTargets) {
        const entry = entryByExternalId.get(target.horseExternalId);

        if (!entry) {
          console.log(`result not found: ${raceId} ${raceResult.name} ${target.horse.name}`);
          continue;
        }

        const point = getPoint(entry.result, raceResult.prizes);
        console.log(
          `${options.dryRun ? "would create" : "created"}: ${raceResult.date} ${
            raceResult.name
          } (${raceId}) ${target.horse.name} result=${entry.result} odds=${
            entry.odds
          } point=${point} course=${raceResult.course} grade=${raceResult.grade}`
        );

        if (options.dryRun) {
          createdCount++;
          continue;
        }

        const { default: prisma } = await import("../src/lib/prisma");
        await prisma.race.create({
          data: {
            raceId,
            name: raceResult.name,
            odds: entry.odds,
            point,
            result: entry.result,
            horseId: target.horse.id,
            date: raceResult.date,
            url: raceResult.url,
            course: raceResult.course,
            grade: raceResult.grade,
          },
        });
        createdCount++;

        for (const owner of target.horse.owners) {
          revalidatePaths.push(...getOwnerRevalidatePaths(owner, target.horse.id));
        }
      }
    } catch (error) {
      if (error instanceof NetkeibaBlockedError) {
        throw error;
      }

      failedRaceIds.push(raceId);
      console.error(`failed to register result: ${raceId}`);
      console.error(error);
    }

    await sleep(RACE_REQUEST_INTERVAL_MS);
  }

  if (!options.dryRun && createdCount > 0) {
    await postRevalidate(revalidatePaths);
  }

  console.log(
    options.dryRun ? `races would create: ${createdCount}` : `created races: ${createdCount}`
  );
  console.log(`failed horses: ${failedHorseIds.length}`);
  console.log(`failed races: ${failedRaceIds.length}`);

  if (failedRaceIds.length > 0) {
    for (const raceId of failedRaceIds) {
      console.log(`failed: ${raceId}`);
    }
  }

  if (failedHorseIds.length > 0 || failedRaceIds.length > 0) {
    process.exitCode = 1;
  }
};

main()
  .catch((error) => {
    if (error instanceof NetkeibaBlockedError) {
      console.error(`${error.message}: stopped to avoid further blocking`);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    if (disconnectPrisma) {
      await disconnectPrisma();
    }
  });
