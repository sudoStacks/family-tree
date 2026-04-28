#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import axios from "axios";

import { getLatestConvertedJsonPath } from "./_json-latest.js";
import { getEnabledSources, readContextConfig, fetchFromSource } from "./lib/sources/index.js";
import { getOWIDContext } from "./lib/sources/our-world-in-data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const contextRoot = path.join(projectRoot, "data", "historical-context");
const rawFactsRoot = path.join(contextRoot, ".raw-facts");
const wikiCacheRoot = path.join(contextRoot, ".wiki-cache");
const rawFactsRelativeRoot = path.join("data", "historical-context", ".raw-facts");
fs.mkdirSync(path.join(projectRoot, "data", "historical-context", ".raw-facts"), { recursive: true });

const WIKIMEDIA_USER_AGENT =
  "family-tree-book-generator/1.0 (github.com/sudostacks/family-tree; genealogy research tool)";

const sourceLastCall = new Map();
let lastWikiCall = 0;

function parseArgs(argv) {
  const args = {
    auto: false,
    resume: false,
    layer: null,
    period: null,
    scope: null,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--auto") args.auto = true;
    else if (a === "--resume") args.resume = true;
    else if (a === "--layer") args.layer = String(argv[++i] || "").trim();
    else if (a === "--period") args.period = String(argv[++i] || "").trim();
    else if (a === "--scope") args.scope = String(argv[++i] || "").trim();
    else if (a === "--force") args.force = true;
  }
  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function yearFromISO(value) {
  if (!value || typeof value !== "string") return null;
  const m = value.match(/^(\d{4})-/);
  if (!m) return null;
  const y = Number(m[1]);
  return Number.isFinite(y) ? y : null;
}

function determineYearRange(individuals) {
  const birthYears = individuals.map((p) => yearFromISO(p?.birth?.dateISO)).filter((y) => y !== null);
  const deathYears = individuals.map((p) => yearFromISO(p?.death?.dateISO)).filter((y) => y !== null);
  const minBirth = birthYears.length ? Math.min(...birthYears) : 1800;
  const maxDeath = deathYears.length ? Math.max(...deathYears) : null;
  const maxBirth = birthYears.length ? Math.max(...birthYears) : minBirth;
  const maxYear = maxDeath ?? maxBirth;
  return { min: minBirth - 10, max: maxYear + 10 };
}

function buildPeriods(minYear, maxYear) {
  const periods = [];
  const start = Math.floor(minYear / 5) * 5;
  for (let y = start; y <= maxYear; y += 5) periods.push(`${y}-${y + 4}`);
  return periods;
}

function loadTree() {
  const jsonPath = getLatestConvertedJsonPath();
  const payload = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  return Array.isArray(payload?.individuals) ? payload.individuals : [];
}

function resolveTargets(config, layerArg, scopeArg) {
  const scopes = config?.scopes || {};
  const targets = [
    ...(Array.isArray(scopes.world) ? scopes.world.map((scope) => ({ layer: "world", scope })) : []),
    ...(Array.isArray(scopes.country) ? scopes.country.map((scope) => ({ layer: "country", scope })) : []),
    ...(Array.isArray(scopes.region) ? scopes.region.map((scope) => ({ layer: "region", scope })) : []),
  ];

  let out = targets;
  if (layerArg) out = out.filter((t) => t.layer.toLowerCase() === layerArg.toLowerCase() || t.scope.toLowerCase() === layerArg.toLowerCase());
  if (scopeArg) out = out.filter((t) => t.scope.toLowerCase() === scopeArg.toLowerCase());
  return out;
}

function rawFactsPath(scope, period) {
  const rawPath = path.join(rawFactsRelativeRoot, `${scope}-${period}.json`);
  return path.join(projectRoot, rawPath);
}

function parsePeriod(period) {
  const [a, b] = String(period || "").split("-");
  const start = Number(a);
  const end = Number(b);
  return {
    startYear: Number.isFinite(start) ? start : null,
    endYear: Number.isFinite(end) ? end : null,
  };
}

async function throttleBySource(sourceConfig) {
  const minGap = Number(sourceConfig?.rateLimit || 0);
  if (!minGap) return;
  const now = Date.now();
  const last = sourceLastCall.get(sourceConfig.id) || 0;
  const waitMs = Math.max(0, minGap - (now - last));
  if (waitMs > 0) await sleep(waitMs);
  sourceLastCall.set(sourceConfig.id, Date.now());
}

function wikiCachePath(scope, period) {
  ensureDir(wikiCacheRoot);
  const safe = String(`${scope}-${period}`).replace(/[^A-Za-z0-9_-]/g, "-");
  return path.join(wikiCacheRoot, `${safe}.json`);
}

async function throttleWiki() {
  const now = Date.now();
  const waitMs = Math.max(0, 1000 - (now - lastWikiCall));
  if (waitMs > 0) await sleep(waitMs);
  lastWikiCall = Date.now();
}

async function wikipediaFallback(scope, period) {
  const cache = wikiCachePath(scope, period);
  if (fs.existsSync(cache)) {
    return JSON.parse(fs.readFileSync(cache, "utf-8"));
  }

  const query = `${scope} history ${period}`;
  await throttleWiki();
  const searchUrl =
    "https://en.wikipedia.org/w/api.php" +
    "?action=query" +
    "&list=search" +
    `&srsearch=${encodeURIComponent(query)}` +
    "&format=json" +
    "&srlimit=3";

  const search = await axios.get(searchUrl, {
    timeout: 10_000,
    headers: {
      "User-Agent": WIKIMEDIA_USER_AGENT,
      Accept: "application/json",
    },
  });

  const hits = Array.isArray(search?.data?.query?.search) ? search.data.query.search : [];
  const items = [];
  for (const hit of hits) {
    const title = String(hit?.title || "").trim();
    if (!title) continue;
    await throttleWiki();
    try {
      const summary = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
        timeout: 10_000,
        headers: {
          "User-Agent": WIKIMEDIA_USER_AGENT,
          Accept: "application/json",
        },
      });
      const text = String(summary?.data?.extract || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      items.push({
        sourceId: "wikipedia_fallback",
        sourceName: "Wikipedia (fallback)",
        sourceUrl: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`,
        title,
        text,
        year: parsePeriod(period).startYear,
        type: "article",
        license: null,
        attribution: "Wikipedia contributors",
      });
    } catch {
      // ignore summary failures
    }
  }

  const payload = { scope, period, items };
  fs.writeFileSync(cache, JSON.stringify(payload, null, 2));
  return payload;
}

function parentFallbackTargets(target) {
  if (target.layer === "region") return ["country", "world"];
  if (target.layer === "country") return ["world"];
  return [];
}

function mapParentScope(target, parentLayer) {
  if (parentLayer === "country") {
    return ["Ohio", "Indiana", "Pennsylvania", "Virginia", "Illinois"].includes(target.scope) ? "USA" : target.scope;
  }
  if (parentLayer === "world") return "global";
  return target.scope;
}

async function fetchRawFactsForTargetPeriod({ target, period, sources, resume, force }) {
  const rawPath = rawFactsPath(target.scope, period);
  if (resume && !force && fs.existsSync(rawPath)) return { skipped: true, outPath: rawPath, count: 0 };

  const { startYear, endYear } = parsePeriod(period);
  const allItems = [];

  for (const source of sources) {
    if (source.id === "our_world_in_data") continue;
    await throttleBySource(source);
    try {
      const items = await fetchFromSource(source, target.scope, startYear, endYear);
      if (Array.isArray(items) && items.length) allItems.push(...items);
    } catch {
      // source failures should not halt pipeline
    }
  }

  let statistics = { lifeExpectancy: null, literacyRate: null, gdpPerCapita: null };
  try {
    const mid = Math.floor((startYear + endYear) / 2);
    const stats = await getOWIDContext(target.scope, mid);
    statistics = stats?.statistics || statistics;
    if (Array.isArray(stats?.lines)) {
      for (const line of stats.lines) {
        allItems.push({
          sourceId: "our_world_in_data",
          sourceName: "Our World In Data",
          sourceUrl: "https://ourworldindata.org",
          title: `${target.scope} statistics ${period}`,
          text: line,
          year: mid,
          type: "statistic",
          license: "CC BY",
          attribution: "Our World In Data",
        });
      }
    }
  } catch {
    // statistics are optional
  }

  if (!allItems.length) {
    const parentLayers = parentFallbackTargets(target);
    if (parentLayers.length) {
      const chain = [target.scope];
      for (const layer of parentLayers) {
        const scope = mapParentScope(target, layer);
        chain.push(scope);
      }
      if (chain.length > 1) {
        console.log(`Context fallback: ${chain.join(" -> ")}`);
      }
    }

    const fallback = await wikipediaFallback(target.scope, period);
    if (Array.isArray(fallback?.items)) allItems.push(...fallback.items);
  }

  const dedupedSources = [];
  const seenSourceKeys = new Set();
  for (const item of allItems) {
    const key = [
      String(item?.sourceId || "").trim().toLowerCase(),
      String(item?.title || "").trim().toLowerCase(),
      Number.isFinite(Number(item?.year)) ? Number(item.year) : "na",
    ].join("|");
    if (seenSourceKeys.has(key)) continue;
    seenSourceKeys.add(key);
    dedupedSources.push(item);
  }

  const imageUrls = Array.from(
    new Set(
      dedupedSources
        .map((item) => String(item?.imageUrl || "").trim())
        .filter(Boolean),
    ),
  );

  const payload = {
    scope: target.scope,
    period,
    fetchedAt: new Date().toISOString(),
    sources: dedupedSources,
    imageUrls,
    statistics,
  };

  fs.mkdirSync(path.join(projectRoot, "data", "historical-context", ".raw-facts"), { recursive: true });
  console.log("Writing raw facts to:", rawPath);
  fs.writeFileSync(rawPath, JSON.stringify(payload, null, 2));
  return { skipped: false, outPath: rawPath, count: dedupedSources.length };
}

export async function runFetchSources(args = {}) {
  const config = readContextConfig();
  const sources = getEnabledSources(config);
  const individuals = loadTree();
  const { min, max } = determineYearRange(individuals);
  let periods = buildPeriods(min, max);
  if (args.period) periods = periods.filter((p) => p === args.period);
  if (periods.length === 0) throw new Error("No periods selected for source fetch.");

  const targets = resolveTargets(config, args.layer, args.scope);
  if (!targets.length) throw new Error("No targets resolved from configuration/layer/scope filters.");

  const total = periods.length * targets.length;
  let completed = 0;
  let fetched = 0;

  for (const target of targets) {
    for (const period of periods) {
      const result = await fetchRawFactsForTargetPeriod({
        target,
        period,
        sources,
        resume: Boolean(args.resume),
        force: Boolean(args.force),
      });
      completed += 1;
      if (!result.skipped) fetched += 1;
      if (completed % 10 === 0 || completed === total) {
        console.log(`Fetched ${completed}/${total} raw contexts | Scope: ${target.scope} | Current: ${period}...`);
      }
    }
  }

  return {
    yearRange: { min, max },
    periods,
    targets,
    total,
    fetched,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runFetchSources(args);
  console.log(`Raw source fetch complete. Updated files: ${result.fetched}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Error:", error.message);
    process.exit(1);
  });
}
