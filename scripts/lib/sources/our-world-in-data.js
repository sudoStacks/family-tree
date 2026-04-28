import fs from "fs";
import path from "path";

import { csvParse, ensureDir, extractYear, firstSentences, httpGet, normalizeItem, owidDataRoot, readCache, scopeQuery, sourceCachePath, writeCache } from "./utils.js";

const SOURCE_ID = "our_world_in_data";
const SOURCE_NAME = "Our World In Data";
const BASE = "https://ourworldindata.org/grapher";

const DATASETS = {
  lifeExpectancy: "life-expectancy.csv",
  gdpPerCapita: "gdp-per-capita.csv",
  literacyRate: "literacy-rate.csv",
};

async function ensureDataset(fileName) {
  ensureDir(owidDataRoot);
  const filePath = path.join(owidDataRoot, fileName);
  if (fs.existsSync(filePath)) return filePath;

  const url = `${BASE}/${fileName}`;
  try {
    const res = await httpGet(url, { timeout: 20_000, headers: { Accept: "text/csv" } });
    fs.writeFileSync(filePath, String(res?.data || ""));
  } catch {
    fs.writeFileSync(filePath, "");
  }
  return filePath;
}

function matchCountry(scope) {
  const map = {
    USA: "United States",
    UK: "United Kingdom",
    Germany: "Germany",
    Ireland: "Ireland",
    Czech: "Czech Republic",
    Ohio: "United States",
    Indiana: "United States",
    Pennsylvania: "United States",
    Virginia: "United States",
    Illinois: "United States",
    global: "World",
  };
  return map[scope] || scope;
}

function nearestValue(rows, country, year) {
  const filtered = rows
    .map((r) => {
      const entity = String(r.Entity || r.entity || "").trim();
      const y = Number(r.Year || r.year);
      const vals = Object.values(r).map((x) => Number(x)).filter((n) => Number.isFinite(n));
      const value = vals.length ? vals[vals.length - 1] : null;
      return { entity, year: y, value };
    })
    .filter((r) => r.entity === country && Number.isFinite(r.year) && Number.isFinite(r.value));

  if (!filtered.length) return null;
  filtered.sort((a, b) => Math.abs(a.year - year) - Math.abs(b.year - year));
  return filtered[0];
}

export async function getOWIDContext(scope, year) {
  const country = matchCountry(scope);
  const targets = {
    lifeExpectancy: await ensureDataset(DATASETS.lifeExpectancy),
    gdpPerCapita: await ensureDataset(DATASETS.gdpPerCapita),
    literacyRate: await ensureDataset(DATASETS.literacyRate),
  };

  const lifeRows = csvParse(fs.readFileSync(targets.lifeExpectancy, "utf-8"));
  const gdpRows = csvParse(fs.readFileSync(targets.gdpPerCapita, "utf-8"));
  const litRows = csvParse(fs.readFileSync(targets.literacyRate, "utf-8"));

  const life = nearestValue(lifeRows, country, year);
  const gdp = nearestValue(gdpRows, country, year);
  const literacy = nearestValue(litRows, country, year);

  const statistics = {
    lifeExpectancy: life ? Number(life.value.toFixed(2)) : null,
    gdpPerCapita: gdp ? Number(gdp.value.toFixed(2)) : null,
    literacyRate: literacy ? Number(literacy.value.toFixed(2)) : null,
  };

  const lines = [];
  if (statistics.lifeExpectancy !== null) {
    lines.push(`Life expectancy in ${country} around ${year} was approximately ${statistics.lifeExpectancy} years.`);
  }
  if (statistics.gdpPerCapita !== null) {
    lines.push(`GDP per capita in ${country} near ${year} was roughly ${statistics.gdpPerCapita}.`);
  }
  if (statistics.literacyRate !== null) {
    lines.push(`Adult literacy in ${country} around ${year} was about ${statistics.literacyRate}.`);
  }

  return { statistics, lines };
}

export async function fetch(scope, startYear, endYear) {
  const cacheKey = `${scopeQuery(scope, startYear, endYear)}-owid`;
  const cacheFile = sourceCachePath(SOURCE_ID, cacheKey);
  const cached = readCache(cacheFile);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  const midYear = Math.floor((startYear + endYear) / 2);
  const { lines } = await getOWIDContext(scope, midYear);

  const items = lines.map((line) =>
    normalizeItem({
      sourceId: SOURCE_ID,
      sourceName: SOURCE_NAME,
      sourceUrl: "https://ourworldindata.org",
      title: `${scope} statistical context ${startYear}-${endYear}`,
      text: firstSentences(line, 1),
      year: extractYear(line, midYear),
      type: "statistic",
      license: "CC BY",
      attribution: "Our World In Data",
    }),
  );

  writeCache(cacheFile, items);
  return items;
}
