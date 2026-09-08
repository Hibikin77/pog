import { Course, Grade } from "@prisma/client";
import * as cheerio from "cheerio";
import { fetchNetkeibaText } from "./netkeibaFetch";

export type RaceSource = "JRA" | "NAR";

export type RaceResultEntry = {
  horseExternalId: string;
  result: number;
  odds: number;
};

export type RaceResult = {
  raceId: string;
  name: string;
  url: string;
  date: string;
  course: Course;
  grade: Grade;
  prizes: number[];
  entries: RaceResultEntry[];
};

const NETKEIBA_RACE_BASE_URL: Record<RaceSource, string> = {
  JRA: "https://race.netkeiba.com",
  NAR: "https://nar.netkeiba.com",
};

// netkeiba の race_id は JRA/地方とも12桁の数字。5〜6桁目が場コード（JRA: 01〜10、地方: 30以上）。
// 海外レースは英字を含む ID なので対象外
export const getRaceSource = (raceId: string): RaceSource | null => {
  if (!/^\d{12}$/.test(raceId)) {
    return null;
  }

  const venueCode = Number.parseInt(raceId.slice(4, 6), 10);
  return venueCode >= 1 && venueCode <= 10 ? "JRA" : "NAR";
};

export const extractHorseExternalId = (url: string | undefined | null) => {
  return url?.match(/\/horse\/([0-9a-zA-Z]+)/)?.[1] ?? null;
};

export const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();

const parseRaceDate = (href: string | undefined, baseUrl: string) => {
  if (!href) {
    return null;
  }

  return new URL(href, baseUrl).searchParams.get("kaisai_date");
};

// 地方の race_id は「西暦4 + 場2 + 月日4 + R2」なので日付を ID から復元できる
const getDateFromNarRaceId = (raceId: string) => `${raceId.slice(0, 4)}${raceId.slice(6, 10)}`;

// JRA: "本賞金:1100,440,280,170,110万円" / 地方: "本賞金:70.0、24.5、14.0、9.1、4.9万円"
// Race.point は万円の整数なので、地方の小数は切り捨てる（手動登録されてきた既存データと同じ扱い）
export const parsePrizes = (text: string) => {
  const values =
    text
      .replace(/、/g, ",")
      .match(/([0-9.,]+)/g)?.[0]
      ?.split(",") ?? [];
  return values
    .map((value) => Math.floor(Number.parseFloat(value)))
    .filter((value) => !Number.isNaN(value));
};

// グレードアイコンの番号: JRA は 1/2/3 が G1/G2/G3、地方は 19/20/21 が Jpn1/Jpn2/Jpn3。
// それ以外（OP・リステッド・条件戦・格付けのない地方重賞など）は NORMAL
const GRADE_BY_ICON: Record<string, Grade> = {
  "1": Grade.G1,
  "2": Grade.G2,
  "3": Grade.G3,
  "19": Grade.G1,
  "20": Grade.G2,
  "21": Grade.G3,
};

export const parseGrade = (className: string | undefined) => {
  const icon = className?.match(/Icon_GradeType(\d+)/)?.[1];
  return (icon && GRADE_BY_ICON[icon]) || Grade.NORMAL;
};

export const parseRaceResult = (raceId: string, html: string, source: RaceSource): RaceResult => {
  const $ = cheerio.load(html);
  // レース名は JRA が h1.RaceName、地方が div.RaceName
  const raceNameElement = $("h1.RaceName, div.RaceName").first();
  const raceName = normalizeText(raceNameElement.clone().children().remove().end().text());
  const raceData = normalizeText($("div.RaceData01 > span").first().text());
  const date =
    parseRaceDate(
      $("#RaceList_DateList dd.Active a").first().attr("href"),
      NETKEIBA_RACE_BASE_URL[source]
    ) ?? (source === "NAR" ? getDateFromNarRaceId(raceId) : null);
  const grade = parseGrade(raceNameElement.find("span.Icon_GradeType").first().attr("class"));
  const prizes = parsePrizes(normalizeText($("div.RaceData02 > span").last().text()));
  const entries: RaceResultEntry[] = [];

  $("table.RaceTable01 tbody tr").each((_, row) => {
    const result = Number.parseInt(normalizeText($(row).find("td.Result_Num").first().text()), 10);
    const horseExternalId = extractHorseExternalId(
      $(row).find("td.Horse_Info a[href*='/horse/']").first().attr("href")
    );
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

export const fetchRaceResult = async (raceId: string) => {
  const source = getRaceSource(raceId);

  if (!source) {
    throw new Error(`Unsupported race id (overseas or invalid): ${raceId}`);
  }

  const baseUrl = NETKEIBA_RACE_BASE_URL[source];
  const html = await fetchNetkeibaText(`${baseUrl}/race/result.html?race_id=${raceId}`, {
    referer: `${baseUrl}/top/race_list.html`,
  });
  return parseRaceResult(raceId, html, source);
};

export const getPoint = (result: number, prizes: number[]) => {
  return result > 5 ? 0 : prizes[result - 1] ?? 0;
};
