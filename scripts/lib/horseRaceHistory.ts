import * as cheerio from "cheerio";
import { fetchNetkeibaText } from "./netkeibaFetch";
import { normalizeText } from "./raceResult";

export type HorseRaceHistoryItem = {
  raceId: string;
  date: string;
  venue: string;
  raceName: string;
  resultText: string;
};

const NETKEIBA_DB_BASE_URL = "https://db.netkeiba.com";

// netkeiba の馬IDは先頭4桁が生年（例: 2023101729 → 2023年生まれ）
export const getHorseBirthYear = (externalId: string) => {
  return /^\d{10}$/.test(externalId) ? Number.parseInt(externalId.slice(0, 4), 10) : null;
};

// 馬別の競走成績ページ。JRA・地方・海外の全レースが race_id 付きで並ぶ
export const parseHorseRaceHistory = (html: string): HorseRaceHistoryItem[] => {
  const $ = cheerio.load(html);
  const items: HorseRaceHistoryItem[] = [];

  $("table.db_h_race_results tbody tr").each((_, row) => {
    const cells = $(row).find("td");
    const date = normalizeText(cells.eq(0).text()).replace(/\//g, "");
    const venue = normalizeText(cells.eq(1).text());
    const resultText = normalizeText(cells.eq(11).text());
    // 開催列にも /race/list/ へのリンクがあるので、12桁の race_id を持つリンクだけを拾う
    const raceLink = $(row)
      .find("a[href*='/race/']")
      .toArray()
      .map((link) => $(link))
      .find((link) => /\/race\/[0-9a-zA-Z]{12}\//.test(link.attr("href") ?? ""));
    const raceId = raceLink?.attr("href")?.match(/\/race\/([0-9a-zA-Z]{12})\//)?.[1] ?? null;
    const raceName = normalizeText(raceLink?.text() ?? "");

    if (raceId && /^\d{8}$/.test(date)) {
      items.push({
        raceId,
        date,
        venue,
        raceName,
        resultText,
      });
    }
  });

  return items;
};

export const fetchHorseRaceHistory = async (externalId: string) => {
  const html = await fetchNetkeibaText(`${NETKEIBA_DB_BASE_URL}/horse/result/${externalId}/`, {
    referer: `${NETKEIBA_DB_BASE_URL}/horse/${externalId}/`,
    encoding: "euc-jp",
  });
  return parseHorseRaceHistory(html);
};
