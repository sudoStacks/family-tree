import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import axios from "axios";

import { getCachedOrFetchCommonsImage } from "./wikimedia.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "../..");

const PLACE_CACHE_DIR = path.join(projectRoot, "data", "place-cache");

const WIKIMEDIA_USER_AGENT =
  "family-tree-book-generator/1.0 (github.com/sudostacks/family-tree; genealogy research tool)";

let lastWikipediaCallAt = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttleWikipedia() {
  const now = Date.now();
  const wait = Math.max(0, 1000 - (now - lastWikipediaCallAt));
  if (wait > 0) await sleep(wait);
  lastWikipediaCallAt = Date.now();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitize(value) {
  return String(value || "place")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function cachePath(placeName) {
  return path.join(PLACE_CACHE_DIR, `${sanitize(placeName)}.json`);
}

function splitSentences(text) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  // Simple heuristic: split at ". " but keep punctuation.
  const parts = cleaned.split(/(?<=[.?!])\s+/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function firstTwoSentences(text) {
  const s = splitSentences(text);
  return s.slice(0, 2).join(" ").trim() || null;
}

/**
 * Wikipedia summary API helper (cached, 1 request/sec max).
 */
export async function getPlaceSummary(placeName, decade) {
  const title = String(placeName || "").trim();
  if (!title) return null;

  const cp = cachePath(title);
  if (fs.existsSync(cp)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cp, "utf-8"));
      return cached?.summary || null;
    } catch {
      // ignore and refetch
    }
  }

  ensureDir(PLACE_CACHE_DIR);
  await throttleWikipedia();

  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  try {
    const res = await axios.get(url, {
      timeout: 20_000,
      headers: {
        "User-Agent": WIKIMEDIA_USER_AGENT,
        Accept: "application/json",
      },
    });
    const extract = res?.data?.extract || "";
    const summary = firstTwoSentences(extract);

    fs.writeFileSync(
      cp,
      JSON.stringify(
        {
          placeName: title,
          decade: decade || null,
          summary,
          fetchedAt: new Date().toISOString(),
          source: "wikipedia",
        },
        null,
        2,
      ),
      "utf-8",
    );

    return summary;
  } catch {
    fs.writeFileSync(
      cp,
      JSON.stringify(
        {
          placeName: title,
          decade: decade || null,
          summary: null,
          fetchedAt: new Date().toISOString(),
          source: "wikipedia",
        },
        null,
        2,
      ),
      "utf-8",
    );
    return null;
  }
}

/**
 * Wikimedia Commons place image helper (uses existing caching in wikimedia.js).
 * Returns a local cachePath plus attribution metadata when available.
 */
export async function getPlaceImage(placeName, decade) {
  const name = String(placeName || "").trim();
  if (!name) return null;
  const query = decade ? `${name} ${decade} historic` : `${name} historic`;
  const result = await getCachedOrFetchCommonsImage(query);
  if (!result?.cachePath) return null;
  return {
    cachePath: result.cachePath,
    caption: decade ? `${name}, circa ${decade}` : `${name}`,
    license: result?.metadata?.license || null,
    attribution: result?.metadata?.attribution || null,
    title: result?.metadata?.title || null,
    source: result?.source || "wikimedia",
    ext: result?.ext || null,
    mimeType: result?.mimeType || null,
  };
}

function yearFromISO(dateISO) {
  if (!dateISO || typeof dateISO !== "string") return null;
  const m = dateISO.match(/^(\d{4})-/);
  if (!m) return null;
  const year = Number(m[1]);
  return Number.isFinite(year) ? year : null;
}

function normalizePlaceComponents(place) {
  const parts = String(place || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  // Many genealogical place strings are "City, County, State, Country",
  // but may include additional locality parts. Prefer the LAST components.
  const country = parts.at(-1) || "";
  const state = parts.at(-2) || "";
  const county = parts.at(-3) || "";
  const city = parts.length >= 4 ? parts.slice(0, parts.length - 3).join(", ") : parts.at(0) || "";

  return { city, county, state, country };
}

function regionKeyFromComponents(components) {
  const country = String(components.country || "").trim();
  const state = String(components.state || "").trim();
  const cLower = country.toLowerCase();
  const isUsa = cLower === "usa" || cLower === "united states" || cLower === "united states of america";
  if (isUsa) return `USA|${state || "Unknown"}`;
  return `COUNTRY|${country || "Unknown"}`;
}

function buildChildrenByParent(individuals, families) {
  const childrenByParent = new Map();
  for (const fam of families) {
    const children = Array.isArray(fam?.children) ? fam.children : [];
    const parents = [fam?.husband, fam?.wife].filter(Boolean);
    for (const parentId of parents) {
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, new Set());
      const set = childrenByParent.get(parentId);
      for (const childId of children) set.add(childId);
    }
  }
  return childrenByParent;
}

function buildGenerationMap(individuals, families) {
  const personById = new Map(individuals.filter((p) => p?.id).map((p) => [p.id, p]));
  const childrenByParent = buildChildrenByParent(individuals, families);

  const roots = individuals
    .filter((p) => p?.id)
    .filter((p) => !Array.isArray(p.familiesAsChild) || p.familiesAsChild.length === 0)
    .map((p) => p.id);

  const generation = new Map();
  const queue = [];
  for (const r of roots) {
    generation.set(r, 1);
    queue.push(r);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const g = generation.get(current);
    const kids = childrenByParent.get(current);
    if (!kids) continue;
    for (const childId of kids) {
      if (!personById.has(childId)) continue;
      const nextG = g + 1;
      if (!generation.has(childId) || nextG < generation.get(childId)) {
        generation.set(childId, nextG);
        queue.push(childId);
      }
    }
  }

  return generation;
}

/**
 * Detect homelands: regions with >=3 individuals spanning >=3 consecutive generations.
 * Returns array sorted by individual count desc.
 */
export function detectFamilyHomelands(individuals, families) {
  const gen = buildGenerationMap(individuals, families);
  const regions = new Map(); // regionKey -> { count, gens:Set, earliestGen }

  for (const p of individuals) {
    if (!p?.id) continue;
    const g = gen.get(p.id);
    if (!g) continue;
    const place = p?.birth?.place || "";
    if (!place) continue;
    const comps = normalizePlaceComponents(place);
    const key = regionKeyFromComponents(comps);
    if (!regions.has(key)) regions.set(key, { count: 0, gens: new Set() });
    const r = regions.get(key);
    r.count += 1;
    r.gens.add(g);
  }

  const out = [];
  for (const [key, info] of regions.entries()) {
    if (info.count < 3) continue;
    const gens = Array.from(info.gens).sort((a, b) => a - b);
    if (gens.length < 3) continue;
    // Check for any 3+ consecutive generations
    let streak = 1;
    let streakStart = gens[0];
    for (let i = 1; i < gens.length; i++) {
      if (gens[i] === gens[i - 1] + 1) streak += 1;
      else {
        streak = 1;
        streakStart = gens[i];
      }
      if (streak >= 3) {
        out.push({ regionKey: key, count: info.count, earliestGeneration: streakStart, generations: gens });
        break;
      }
    }
  }

  return out.sort((a, b) => b.count - a.count);
}

/**
 * Detect a significant shift in primary region across generations for a surname.
 */
export function detectMigrationPattern(individualsByGeneration, surname) {
  const target = String(surname || "").trim().toUpperCase();
  if (!target) return null;

  const perGen = [];
  for (const [gen, people] of individualsByGeneration.entries()) {
    const filtered = people.filter((p) => String(p?.name?.surname || "").trim().toUpperCase() === target);
    if (!filtered.length) continue;
    const regionCounts = new Map();
    const years = [];
    for (const p of filtered) {
      const comps = normalizePlaceComponents(p?.birth?.place || "");
      const key = regionKeyFromComponents(comps);
      regionCounts.set(key, (regionCounts.get(key) || 0) + 1);
      const y = yearFromISO(p?.birth?.dateISO);
      if (y !== null) years.push(y);
    }
    const top = Array.from(regionCounts.entries()).sort((a, b) => b[1] - a[1])[0];
    if (top) perGen.push({ gen: Number(gen), regionKey: top[0], count: top[1], total: filtered.length, years });
  }

  if (perGen.length < 4) return null;

  const first = perGen[0].regionKey;
  const last = perGen[perGen.length - 1].regionKey;
  if (first === last) return null;

  const switchPoint = perGen.find((x) => x.regionKey === last && x.count / Math.max(1, x.total) >= 0.5);
  if (!switchPoint) return null;

  const decade = (() => {
    if (!switchPoint.years?.length) return null;
    const min = Math.min(...switchPoint.years);
    return Number.isFinite(min) ? `${Math.floor(min / 10) * 10}s` : null;
  })();

  return {
    from: first,
    to: last,
    approximateDecade: decade || `Generation ${switchPoint.gen}`,
  };
}
