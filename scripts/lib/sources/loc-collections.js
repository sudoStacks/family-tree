import { firstSentences, httpGet, normalizeItem, readCache, scopeQuery, sourceCachePath, writeCache } from "./utils.js";

const SOURCE_ID = "loc_collections";
const SOURCE_NAME = "Library of Congress Collections";
const CHRONICLING_URL = "https://www.loc.gov/search/";
const LOC_USER_AGENT =
  "family-tree-book-generator/1.0 (github.com/sudostacks/family-tree; genealogy research)";

const US_STATES = [
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "california",
  "colorado",
  "connecticut",
  "delaware",
  "florida",
  "georgia",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "new hampshire",
  "new jersey",
  "new mexico",
  "new york",
  "north carolina",
  "north dakota",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "rhode island",
  "south carolina",
  "south dakota",
  "tennessee",
  "texas",
  "utah",
  "vermont",
  "virginia",
  "washington",
  "west virginia",
  "wisconsin",
  "wyoming",
];

function extractYearFromDate(value) {
  const raw = String(value || "").trim();
  const leading = Number.parseInt(raw.substring(0, 4), 10);
  if (Number.isFinite(leading)) return leading;
  const m = raw.match(/\b(1[6-9]\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

async function queryChroniclingAmerica({ scope, startYear, endYear }) {
  const response = await httpGet(CHRONICLING_URL, {
    headers: {
      "User-Agent": LOC_USER_AGENT,
      Accept: "application/json",
    },
    params: {
      q: `${scope} pioneer`,
      fa: "partof:chronicling america",
      dates: `${startYear}/${endYear}`,
      fo: "json",
      c: 5,
    },
  });

  console.log("LOC raw results:", response.data.results?.length || 0);
  const results = Array.isArray(response?.data?.results) ? response.data.results : [];
  const mapped = results
    .map((result) => {
      const title = String(result?.title || "").trim();
      const date = String(result?.date || "").trim();
      const year = Number.parseInt(String(result?.date || "").substring(0, 4), 10);
      if (Number.isNaN(year)) return null;
      const descArr = Array.isArray(result?.description)
        ? result.description
        : [result?.description].filter(Boolean);
      const subjArr = Array.isArray(result?.subject)
        ? result.subject
        : [result?.subject].filter(Boolean);

      const text =
        (typeof descArr[0] === "string" ? descArr[0].substring(0, 300) : String(descArr[0] || "").substring(0, 300)) ||
        subjArr
          .slice(0, 3)
          .map((s) => String(s || "").trim())
          .filter(Boolean)
          .join(", ") ||
        title ||
        "";
      const finalText = text || title || "Historical newspaper page";

      if (!Number.isFinite(year) || year < startYear - 2 || year > endYear + 2) return null;
      if (title.toLowerCase().includes("finding aid")) return null;

      return {
        ...normalizeItem({
          sourceId: SOURCE_ID,
          sourceName: SOURCE_NAME,
          sourceUrl: result?.url || CHRONICLING_URL,
          title: title || "Chronicling America page",
          text: firstSentences(finalText, 3),
          year,
          type: "newspaper",
          license: null,
          attribution: "Library of Congress",
        }),
        date,
        place: Array.isArray(result?.location) ? String(result.location[0] || scope) : scope,
      };
    })
    .filter(Boolean);

  console.log("LOC after filter:", mapped.length);
  console.log(`Chronicling America (new API): ${mapped.length} results for ${scope} ${startYear}-${endYear}`);
  console.log("LOC returning:", mapped.length, "items");
  return mapped;
}

export async function fetch(scope, startYear, endYear) {
  const cacheKey = `${scopeQuery(scope, startYear, endYear)}-loc`;
  const cacheFile = sourceCachePath(SOURCE_ID, cacheKey);
  const cached = readCache(cacheFile);
  if (cached && Array.isArray(cached) && cached.length > 0) {
    console.log("LOC cache hit:", cached.length, "items");
    return cached;
  }

  const normalizedScope = String(scope || "").toLowerCase().trim();
  const isUSState = US_STATES.includes(normalizedScope);
  const isInChroniclingRange = Number(startYear) >= 1770 && Number(endYear) <= 1965;

  if (!isUSState || !isInChroniclingRange) {
    console.log(`LOC skipped: ${scope} ${startYear}-${endYear} (Chronicling America covers US states 1770-1965 only)`);
    console.log("LOC returning:", 0, "items");
    writeCache(cacheFile, []);
    return [];
  }

  try {
    const results = await queryChroniclingAmerica({
      scope,
      startYear,
      endYear,
    });
    writeCache(cacheFile, results);
    console.log("LOC returning:", results.length, "items");
    return results;
  } catch (error) {
    console.log("LOC error:", error?.message || "unknown error");
    writeCache(cacheFile, []);
    console.log("LOC returning:", 0, "items");
    return [];
  }
}
