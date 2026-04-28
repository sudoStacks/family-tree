import { extractYear, firstSentences, httpGet, normalizeItem, readCache, scopeQuery, sourceCachePath, writeCache } from "./utils.js";

const SOURCE_ID = "europeana";
const SOURCE_NAME = "Europeana";
const SOURCE_URL = "https://api.europeana.eu/record/v2/search.json";

export async function fetch(scope, startYear, endYear, options = {}) {
  const cacheKey = `${scopeQuery(scope, startYear, endYear)}-europeana`;
  const cacheFile = sourceCachePath(SOURCE_ID, cacheKey);
  const cached = readCache(cacheFile);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  const apiKey = options.apiKey || process.env.EUROPEANA_API_KEY || "";
  if (!apiKey) return [];

  try {
    const res = await httpGet(SOURCE_URL, {
      params: {
        wskey: apiKey,
        query: `${scope} ${startYear}-${endYear} history`,
        reusability: "open",
        media: true,
        rows: 20,
      },
    });

    const records = Array.isArray(res?.data?.items) ? res.data.items : [];
    const items = records
      .map((record) => {
        const description = Array.isArray(record?.dcDescription)
          ? record.dcDescription.join(" ")
          : String(record?.dcDescription || "");
        const title = Array.isArray(record?.title) ? record.title[0] : record?.title || "";
        const text = firstSentences(description, 3);
        return normalizeItem({
          sourceId: SOURCE_ID,
          sourceName: SOURCE_NAME,
          sourceUrl: record?.guid || SOURCE_URL,
          title,
          text,
          year: extractYear(`${record?.timestamp || ""} ${description}`, startYear),
          type: "document",
          license: Array.isArray(record?.rights) ? record.rights[0] : null,
          attribution: Array.isArray(record?.dataProvider) ? record.dataProvider[0] : null,
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
