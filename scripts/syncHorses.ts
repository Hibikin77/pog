import * as cheerio from "cheerio";
import { getOwnerRevalidatePaths, postRevalidate } from "./lib/revalidate";

type CliOptions = {
  dryRun: boolean;
  horseIds: number[];
  urlOverrides: Map<number, string>;
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

const NETKEIBA_DB_BASE_URL = "https://db.netkeiba.com";
const REQUEST_INTERVAL_MS = 600;
let disconnectPrisma: (() => Promise<void>) | null = null;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    urlOverrides: new Map(),
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    const separatorIndex = arg.indexOf("=");
    const key = separatorIndex === -1 ? arg : arg.slice(0, separatorIndex);
    const value = separatorIndex === -1 ? undefined : arg.slice(separatorIndex + 1);

    switch (key) {
      case "--horse-ids":
        options.horseIds.push(
          ...parseCsvOption(value)
            .map((id) => Number.parseInt(id, 10))
            .filter((id) => !Number.isNaN(id))
        );
        break;
      case "--set-url": {
        // --set-url=<horseId>:<url> を複数指定可（URL側に ':' が含まれるため最初の ':' で分割）
        const colonIndex = value?.indexOf(":") ?? -1;
        const horseId = Number.parseInt(value?.slice(0, colonIndex) ?? "", 10);
        const url = value?.slice(colonIndex + 1);

        if (colonIndex === -1 || Number.isNaN(horseId) || !url) {
          throw new Error(`invalid --set-url: ${value}`);
        }

        options.urlOverrides.set(horseId, url);
        break;
      }
    }
  }

  options.horseIds = [...new Set([...options.horseIds, ...options.urlOverrides.keys()])];

  return options;
};

const extractHorseExternalId = (url: string | undefined | null) => {
  return url?.match(/\/horse\/([0-9a-zA-Z]+)/)?.[1] ?? null;
};

const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();

// 「○○の2024」のような馬名未定表記
const isPlaceholderName = (name: string) => /の20\d\d$/.test(name);

const fetchHorseName = async (externalId: string) => {
  const response = await fetch(`${NETKEIBA_DB_BASE_URL}/horse/${externalId}/`, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch horse ${externalId}: ${response.status} ${response.statusText}`
    );
  }

  const html = new TextDecoder("euc-jp").decode(await response.arrayBuffer());
  const $ = cheerio.load(html);
  const name = normalizeText($(".horse_title h1").first().text());

  if (!name) {
    throw new Error(`Horse name is not found: ${externalId}`);
  }

  return name;
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  console.log(`dry run: ${options.dryRun}`);

  const { default: prisma } = await import("../src/lib/prisma");
  disconnectPrisma = () => prisma.$disconnect();

  const horses: TargetHorse[] = await prisma.horse.findMany({
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

  console.log(`target horses: ${horses.length}`);

  for (const horseId of options.urlOverrides.keys()) {
    if (!horses.some((horse) => horse.id === horseId)) {
      console.log(`skipped url override: horse ${horseId} is not an active horse`);
    }
  }

  const revalidatePaths: string[] = [];
  const failedHorseIds: number[] = [];
  let updatedCount = 0;

  for (const horse of horses) {
    const nextUrl = options.urlOverrides.get(horse.id) ?? horse.url;
    const externalId = extractHorseExternalId(nextUrl);

    if (!externalId || !/^\d+$/.test(externalId)) {
      console.log(`skipped: horse ${horse.id} ${horse.name} has invalid url: ${nextUrl}`);
      failedHorseIds.push(horse.id);
      continue;
    }

    try {
      const fetchedName = await fetchHorseName(externalId);
      const nextName = isPlaceholderName(fetchedName) ? horse.name : fetchedName;
      const data: { name?: string; url?: string } = {};

      if (nextName !== horse.name) {
        data.name = nextName;
      }

      if (nextUrl !== horse.url) {
        data.url = nextUrl;
      }

      if (Object.keys(data).length === 0) {
        continue;
      }

      console.log(
        `${options.dryRun ? "would update" : "update"}: horse ${horse.id} ${JSON.stringify({
          name: data.name ? `${horse.name} -> ${data.name}` : undefined,
          url: data.url ? `${horse.url} -> ${data.url}` : undefined,
        })}`
      );

      if (!options.dryRun) {
        await prisma.horse.update({
          where: {
            id: horse.id,
          },
          data,
        });
        updatedCount++;

        for (const owner of horse.owners) {
          revalidatePaths.push(...getOwnerRevalidatePaths(owner, horse.id));
        }
      }
    } catch (error) {
      failedHorseIds.push(horse.id);
      console.error(`failed to sync horse: ${horse.id} ${horse.name}`);
      console.error(error);
    }

    await sleep(REQUEST_INTERVAL_MS);
  }

  if (updatedCount > 0) {
    await postRevalidate(revalidatePaths);
  }

  console.log(`updated horses: ${updatedCount}`);
  console.log(`failed horses: ${failedHorseIds.length}`);

  if (failedHorseIds.length > 0) {
    process.exitCode = 1;
  }
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
