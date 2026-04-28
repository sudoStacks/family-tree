import { extractYear, firstSentences, httpGet, normalizeItem, readCache, scopeQuery, sourceCachePath, writeCache } from "./utils.js";

const SOURCE_ID = "chronicling_america";
const SOURCE_NAME = "Chronicling America (Library of Congress)";
const SOURCE_URL = "https://chroniclingamerica.loc.gov/search/pages/results/";

const STATE_MAP = {
  Ohio: "Ohio",
  Indiana: "Indiana",
  Pennsylvania: "Pennsylvania",
  Virginia: "Virginia",
  Illinois: "Illinois",
};

export async function fetch(scope, startYear, endYear) {
  const cacheKey = `${scopeQuery(scope, startYear, endYear)}-ca`;
  const cacheFile = sourceCachePath(SOURCE_ID, cacheKey);
  const cached = readCache(cacheFile);
  if (cached) return cached;

  const state = STATE_MAP[scope] || "";
  if (!state) return [];

  try {
    const res = await httpGet(SOURCE_URL, {
      params: {
        format: "json",
        state,
        dateFilterType: "yearRange",
        date1: startYear,
        date2: endYear,
        rows: 15,
      },
    });

    const records = Array.isArray(res?.data?.items) ? res.data.items : [];
    const items = records
      .map((record) => {
        const ocr = firstSentences(String(record?.ocr_eng || "").split(/\s+/).slice(0, 200).join(" "), 3);
        const title = record?.title || record?.newspaper || "Chronicling America article";
        return normalizeItem({
          sourceId: SOURCE_ID,
          sourceName: SOURCE_NAME,
          sourceUrl: record?.url || SOURCE_URL,
          title,
          text: ocr,
          year: extractYear(`${record?.date || ""} ${ocr}`, startYear),
          type: "newspaper",
          license: null,
          attribution: "Library of Congress",
        });
      })
      .filter((item) => item.text);

    writeCache(cacheFile, items);
    return items;
  } catch {
    writeCache(cacheFile, []);
    return [];
  }
}
