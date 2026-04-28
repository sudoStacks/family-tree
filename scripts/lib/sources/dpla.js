import { extractYear, firstSentences, httpGet, normalizeItem, readCache, scopeQuery, sourceCachePath, writeCache } from "./utils.js";

const SOURCE_ID = "dpla";
const SOURCE_NAME = "Digital Public Library of America";
const SOURCE_URL = "https://api.dp.la/v2/items";
const COUNTRY_SCOPES = ["USA", "Germany", "Ireland", "Czech", "UK"];

function isGlobalScope(scope) {
  const value = String(scope || "").toLowerCase().trim();
  return value === "global" || value === "world";
}

function isCountryScope(scope) {
  return COUNTRY_SCOPES.includes(String(scope || "").trim());
}

function buildQuery(scope) {
  const clean = String(scope || "").trim();
  if (isGlobalScope(clean)) return "history";
  if (isCountryScope(clean)) return clean === "USA" ? "United States" : clean;
  return clean;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function stringFromMaybeObject(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const candidates = ["text", "name", "displayDate", "value", "title"];
    for (const key of candidates) {
      if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
    }
  }
  return "";
}

function normalizeDplaItem(doc, startYear) {
  const titleArr = toArray(doc?.sourceResource?.title).map((v) => stringFromMaybeObject(v)).filter(Boolean);
  const title = titleArr[0] || "";
  const descriptionArr = toArray(doc?.sourceResource?.description).map((v) => stringFromMaybeObject(v)).filter(Boolean);
  const description = descriptionArr[0] ? descriptionArr[0].slice(0, 200) : "";
  const subjectArr = toArray(doc?.sourceResource?.subject)
    .map((s) => stringFromMaybeObject(s && typeof s === "object" ? (s.name ?? s) : s))
    .filter(Boolean)
    .slice(0, 3);
  const dateArr = toArray(doc?.sourceResource?.date);
  const displayDate = dateArr.length ? stringFromMaybeObject(dateArr[0]) : "";
  const typeArr = toArray(doc?.sourceResource?.type).map((v) => stringFromMaybeObject(v)).filter(Boolean);
  const type = (typeArr[0] || "document").toLowerCase();

  if (!description && subjectArr.length === 0) return null;
  if (type.includes("moving image") || type.includes("sound")) return null;
  if (title.toLowerCase().includes("finding aid") || title.toLowerCase().includes("collection guide")) return null;

  const text = firstSentences(
    [description || "", subjectArr.length ? `Subjects: ${subjectArr.join(", ")}` : ""].filter(Boolean).join(" "),
    3,
  );
  if (!text) return null;

  return normalizeItem({
    sourceId: SOURCE_ID,
    sourceName: SOURCE_NAME,
    sourceUrl: doc?.isShownAt || SOURCE_URL,
    title,
    text,
    year: extractYear(String(displayDate || ""), startYear),
    type,
    license: doc?.rights || null,
    attribution: doc?.provider?.name || null,
  });
}

async function runDplaQuery({ apiKey, q, startYear, endYear, useDateFilter, pageSize }) {
  const params = {
    api_key: apiKey,
    q,
    page_size: pageSize,
  };
  if (useDateFilter) {
    params["sourceResource.date.after"] = String(startYear - 2);
    params["sourceResource.date.before"] = String(endYear + 2);
  }
  const res = await httpGet(SOURCE_URL, { params });
  const docs = Array.isArray(res?.data?.docs) ? res.data.docs : [];
  console.log(`DPLA query: ${q} | ${startYear - 2}-${endYear + 2} → ${docs.length} results`);
  return docs;
}

export async function fetch(scope, startYear, endYear, options = {}) {
  const cacheKey = `${scopeQuery(scope, startYear, endYear)}-dpla`;
  const cacheFile = sourceCachePath(SOURCE_ID, cacheKey);
  const cached = readCache(cacheFile);
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  const apiKey = options.apiKey || process.env.DPLA_API_KEY || "";
  if (!apiKey) return [];

  try {
    const baseQuery = buildQuery(scope);
    let docs = await runDplaQuery({
      apiKey,
      q: baseQuery,
      startYear,
      endYear,
      useDateFilter: true,
      pageSize: 10,
    });

    if (docs.length === 0) {
      const decade = Math.floor(Number(startYear) / 10) * 10;
      const fallbackQ = `${baseQuery} ${decade}s`;
      console.log(`DPLA fallback (broader query): ${fallbackQ}`);
      docs = await runDplaQuery({
        apiKey,
        q: fallbackQ,
        startYear,
        endYear,
        useDateFilter: false,
        pageSize: 5,
      });
    }

    const items = docs.map((d) => normalizeDplaItem(d, startYear)).filter(Boolean);
    writeCache(cacheFile, items);
    return items;
  } catch {
    writeCache(cacheFile, []);
    return [];
  }
}
