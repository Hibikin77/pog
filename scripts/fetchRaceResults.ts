import { Course, Grade } from "@prisma/client";
import * as cheerio from "cheerio";
import { match } from "ts-pattern";
import { getCurrentRaceScheduleWeek } from "../src/lib/raceScheduleWeek";
import { getOwnerRevalidatePaths, postRevalidate } from "./lib/revalidate";

type CliOptions = {
  dryRun: boolean;
  force: boolean;
  raceIds: string[];
  maxRaces: number | null;
};

type RaceResultEntry = {
  horseExternalId: string;
  result: number;
  odds: number;
};

type RaceResult = {
  raceId: string;
  name: string;
  url: string;
  date: string;
  course: Course;
  grade: Grade;
  prizes: number[];
  entries: RaceResultEntry[];
};

type ResultTarget = {
  horseId: number;
  horse: {
    id: number;
    name: string;
    url: string;
    owners: {
      id: number;
      seasonId: number;
      ruleId: number;
    }[];
  };
};

const NETKEIBA_RACE_BASE_URL = "https://race.netkeiba.com";
const REQUEST_INTERVAL_MS = 500;
const RESULT_DELAY_MINUTES = 30;
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
    force: false,
    raceIds: [],
    maxRaces: null,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }

    if (arg === "--force") {
      options.force = true;
      continue;
    }

    const [key, value] = arg.split("=");

    switch (key) {
      case "--race-ids":
        options.raceIds.push(...parseCsvOption(value));
        break;
      case "--max-races":
        options.maxRaces = value ? Number.parseInt(value, 10) : null;
        break;
    }
  }

  if (options.dryRun) {
    options.raceIds.push(...parseCsvOption(process.env.DRY_RUN_RACE_IDS));
  }
  options.raceIds = [...new Set(options.raceIds)];

  return options;
};

const fetchText = async (url: string) => {
  const response = await fetch(url, {
    headers: {
      referer: `${NETKEIBA_RACE_BASE_URL}/top/race_list.html`,
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
};

const extractHorseExternalId = (url: string | undefined | null) => {
  return url?.match(/\/horse\/([0-9a-zA-Z]+)/)?.[1] ?? null;
};

const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();

const parseRaceDate = (href: string | undefined) => {
  if (!href) {
    return null;
  }

  return new URL(href, NETKEIBA_RACE_BASE_URL).searchParams.get("kaisai_date");
};

const parsePrizes = (text: string) => {
  const values = text.match(/([0-9,]+)/g)?.[0]?.split(",") ?? [];
  return values.map((value) => Number.parseInt(value, 10)).filter((value) => !Number.isNaN(value));
};

const parseRaceResult = (raceId: string, html: string): RaceResult => {
  const $ = cheerio.load(html);
  const raceName = normalizeText($("h1.RaceName").first().clone().children().remove().end().text());
  const raceData = normalizeText($("div.RaceData01 > span").first().text());
  const date = parseRaceDate($("#RaceList_DateList dd.Active a").first().attr("href"));
  const gradeMatched = $("h1.RaceName span.Icon_GradeType").first().attr("class")?.match(/Icon_GradeType(\d)/)?.[1];
  const grade = match(gradeMatched)
    .with("1", () => Grade.G1)
    .with("2", () => Grade.G2)
    .with("3", () => Grade.G3)
    .otherwise(() => Grade.NORMAL);
  const prizes = parsePrizes(normalizeText($("div.RaceData02 > span").last().text()));
  const entries: RaceResultEntry[] = [];

  $("table.RaceTable01 tbody tr").each((_, row) => {
    const result = Number.parseInt(normalizeText($(row).find("td.Result_Num").first().text()), 10);
    const horseExternalId = extractHorseExternalId($(row).find("td.Horse_Info a[href*='/horse/']").first().attr("href"));
    const odds = Number.parseFloat(normalizeText($(row).find("td.Odds.Txt_R").first().text()));

    if (horseExternalId && !Number.isNaN(result) && !Number.isNaN(odds)) {
      entries.push({
        horseExternalId,
        result,
        odds,
      });
    }
  });

  if (!raceName) {
    throw new Error(`Race name is not found: ${raceId}`);
  }

  if (!date) {
    throw new Error(`Race date is not found: ${raceId}`);
  }

  if (prizes.length === 0) {
    throw new Error(`Prizes are not found: ${raceId}`);
  }

  if (entries.length === 0) {
    throw new Error(`Race result entries are not found: ${raceId}`);
  }

  return {
    raceId,
    name: raceName,
    url: `https://db.netkeiba.com/race/${raceId}/`,
    date,
    course: raceData.includes("芝") ? Course.TURF : Course.DART,
    grade,
    prizes,
    entries,
  };
};

const fetchRaceResult = async (raceId: string) => {
  const html = await fetchText(`${NETKEIBA_RACE_BASE_URL}/race/result.html?race_id=${raceId}`);
  return parseRaceResult(raceId, html);
};

const getTokyoParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    weekday: values.weekday,
    hour: Number.parseInt(values.hour, 10),
    minute: Number.parseInt(values.minute, 10),
  };
};

const isWithinResultUpdateWindow = (date = new Date()) => {
  const { weekday, hour, minute } = getTokyoParts(date);

  if (weekday !== "Sat" && weekday !== "Sun") {
    return false;
  }

  if (hour < 10) {
    return false;
  }

  return hour < 18 || (hour === 18 && minute === 0);
};

const parseRaceDateTime = (date: string, startTime: string) => {
  const year = date.slice(0, 4);
  const month = date.slice(4, 6);
  const day = date.slice(6, 8);
  return new Date(`${year}-${month}-${day}T${startTime}:00+09:00`);
};

const isResultFetchable = (date: string, startTime: string, now = new Date()) => {
  const startAt = parseRaceDateTime(date, startTime).getTime();
  return now.getTime() >= startAt + RESULT_DELAY_MINUTES * 60 * 1000;
};

const getPoint = (result: number, prizes: number[]) => {
  return result > 5 ? 0 : prizes[result - 1] ?? 0;
};

const runDryRun = async (options: CliOptions) => {
  const raceIds = options.maxRaces === null ? options.raceIds : options.raceIds.slice(0, options.maxRaces);

  if (raceIds.length === 0) {
    throw new Error("--race-ids is required in dry run");
  }

  console.log(`dry run race ids: ${raceIds.join(", ")}`);

  for (const raceId of raceIds) {
    const raceResult = await fetchRaceResult(raceId);
    console.log(
      `race ${raceId}: ${raceResult.name} date=${raceResult.date} course=${raceResult.course} grade=${raceResult.grade} entries=${raceResult.entries.length}`
    );
    console.log(
      raceResult.entries
        .slice(0, 5)
        .map((entry) => `${entry.result}:${entry.horseExternalId}:odds=${entry.odds}`)
        .join(", ")
    );
    await sleep(REQUEST_INTERVAL_MS);
  }
};

const main = async () => {
  const options = parseArgs(process.argv.slice(2));
  console.log(`dry run: ${options.dryRun}`);
  console.log(`force: ${options.force}`);

  if (options.dryRun) {
    await runDryRun(options);
    return;
  }

  // --race-ids 指定時はバックフィルモード: 出走予定に依らず指定レースの結果を全アクティブ馬と突き合わせる
  const isBackfill = options.raceIds.length > 0;

  if (!isBackfill && !options.force && !isWithinResultUpdateWindow()) {
    console.log("outside result update window: skipped");
    return;
  }

  const { default: prisma } = await import("../src/lib/prisma");
  disconnectPrisma = () => prisma.$disconnect();

  const activeOwnersSelect = {
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
  } as const;

  const targetsByRaceId = new Map<string, ResultTarget[]>();

  if (isBackfill) {
    const horses = await prisma.horse.findMany({
      where: {
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
        owners: activeOwnersSelect,
      },
    });
    const targets = horses.map((horse) => ({ horseId: horse.id, horse }));

    for (const raceId of options.raceIds) {
      targetsByRaceId.set(raceId, targets);
    }

    console.log(`backfill race ids: ${options.raceIds.join(", ")}`);
    console.log(`active horses: ${horses.length}`);
  } else {
    const { weekStart } = getCurrentRaceScheduleWeek();
    const now = new Date();

    const schedules = await prisma.raceSchedule.findMany({
      where: {
        weekStart,
        startTime: {
          not: null,
        },
        horse: {
          owners: {
            some: {
              season: {
                isActive: true,
              },
            },
          },
        },
      },
      include: {
        horse: {
          select: {
            id: true,
            name: true,
            url: true,
            owners: activeOwnersSelect,
          },
        },
      },
      orderBy: [{ date: "asc" }, { startTime: "asc" }, { raceNumber: "asc" }],
    });

    const fetchableSchedules = schedules.filter((schedule) => {
      return schedule.startTime && isResultFetchable(schedule.date, schedule.startTime, now);
    });

    for (const schedule of fetchableSchedules) {
      const targets = targetsByRaceId.get(schedule.raceId) ?? [];
      targets.push({ horseId: schedule.horseId, horse: schedule.horse });
      targetsByRaceId.set(schedule.raceId, targets);
    }

    console.log(`target weekStart: ${weekStart}`);
    console.log(`fetchable schedules: ${fetchableSchedules.length}`);
  }

  const existingRaces = await prisma.race.findMany({
    where: {
      raceId: {
        in: [...targetsByRaceId.keys()],
      },
    },
    select: {
      horseId: true,
      raceId: true,
    },
  });
  const existingRaceKeys = new Set(existingRaces.map((race) => `${race.horseId}:${race.raceId}`));

  const unregisteredByRaceId = new Map<string, ResultTarget[]>();
  for (const [raceId, targets] of targetsByRaceId) {
    const unregistered = targets.filter((target) => !existingRaceKeys.has(`${target.horseId}:${raceId}`));
    if (unregistered.length > 0) {
      unregisteredByRaceId.set(raceId, unregistered);
    }
  }
  const raceIds = [...unregisteredByRaceId.keys()];
  const targetRaceIds = options.maxRaces === null ? raceIds : raceIds.slice(0, options.maxRaces);

  console.log(
    `unregistered targets: ${[...unregisteredByRaceId.values()].reduce((sum, targets) => sum + targets.length, 0)}`
  );
  console.log(`target races: ${targetRaceIds.length}`);

  const failedRaceIds: string[] = [];
  const revalidatePaths: string[] = [];
  let createdCount = 0;

  for (const raceId of targetRaceIds) {
    const raceTargets = unregisteredByRaceId.get(raceId) ?? [];

    try {
      const raceResult = await fetchRaceResult(raceId);
      const entryByExternalId = new Map(
        raceResult.entries.map((entry) => [entry.horseExternalId, entry])
      );

      for (const target of raceTargets) {
        const horseExternalId = extractHorseExternalId(target.horse.url);
        const entry = horseExternalId ? entryByExternalId.get(horseExternalId) : null;

        if (!entry) {
          // バックフィルでは全アクティブ馬が候補なので、不出走馬のログは出さない
          if (!isBackfill) {
            console.log(`result not found: ${raceId} ${target.horse.name}`);
          }
          continue;
        }

        await prisma.race.create({
          data: {
            raceId,
            name: raceResult.name,
            odds: entry.odds,
            point: getPoint(entry.result, raceResult.prizes),
            result: entry.result,
            horseId: target.horseId,
            date: raceResult.date,
            url: raceResult.url,
            course: raceResult.course,
            grade: raceResult.grade,
          },
        });
        createdCount++;
        console.log(
          `created: ${raceId} ${target.horse.name} result=${entry.result} odds=${entry.odds}`
        );

        for (const owner of target.horse.owners) {
          revalidatePaths.push(...getOwnerRevalidatePaths(owner, target.horseId));
        }
      }
    } catch (error) {
      failedRaceIds.push(raceId);
      console.error(`failed to register result: ${raceId}`);
      console.error(error);
    }

    await sleep(REQUEST_INTERVAL_MS);
  }

  if (createdCount > 0) {
    await postRevalidate(revalidatePaths);
  }

  console.log(`created races: ${createdCount}`);
  console.log(`failed races: ${failedRaceIds.length}`);

  if (failedRaceIds.length > 0) {
    for (const raceId of failedRaceIds) {
      console.log(`failed: ${raceId}`);
    }
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
