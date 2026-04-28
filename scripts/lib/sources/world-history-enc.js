import { extractYear, firstSentences, httpGet, normalizeItem, readCache, scopeQuery, sourceCachePath, writeCache } from "./utils.js";

const SOURCE_ID = "world_history_encyclopedia";
const SOURCE_NAME = "World History Encyclopedia";
const SOURCE_URL = "https://api.worldhistory.org/api/v1/";

export async function fetch(scope, startYear, endYear, options = {}) {
  const cacheKey = `${scopeQuery(scope, startYear, endYear)}-whe`;
  const cacheFile = sourceCachePath(SOURCE_ID, cacheKey);
  const cached = readCache(cacheFile);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  const apiKey = options.apiKey || process.env.WHE_API_KEY || "";
  if (!apiKey) return [];

  try {
    const res = await httpGet(`${SOURCE_URL}search`, {
      params: {
        q: `${scope} history ${startYear} ${endYear}`,
        from: startYear,
        to: endYear,
        limit: 10,
        api_key: apiKey,
      },
    });

    const records = Array.isArray(res?.data?.data) ? res.data.data : [];
    const items = records
      .map((record) => {
        const summary = firstSentences(record?.summary || record?.description || "", 3);
        return normalizeItem({
          sourceId: SOURCE_ID,
          sourceName: SOURCE_NAME,
          sourceUrl: record?.url || SOURCE_URL,
          title: record?.title || "",
          text: summary,
          year: extractYear(`${record?.date || ""} ${summary}`, startYear),
          type: "article",
          license: record?.license || null,
          attribution: record?.author || null,
        });
      })
      .filter((item) => item.text && (item.year === null || (item.year >= startYear && item.year <= endYear)));

    writeCache(cacheFile, items);
    return items;
  } catch {
    writeCache(cacheFile, []);
    return [];
  }
}
