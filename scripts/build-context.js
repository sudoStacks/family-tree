#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import axios from "axios";
import dotenv from "dotenv";

import { getLatestConvertedJsonPath } from "./_json-latest.js";
import { readContextConfig } from "./lib/sources/index.js";
import { runFetchSources } from "./fetch-context-sources.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const contextRoot = path.join(projectRoot, "data", "historical-context");
const rawFactsRoot = path.join(contextRoot, ".raw-facts");
const rawFactsRelativeRoot = path.join("data", "historical-context", ".raw-facts");

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

const VARIANT_CONFIG = [
  { id: 0, ageContext: "birth" },
  { id: 1, ageContext: "childhood/adult" },
  { id: 2, ageContext: "late/general" },
];

let lastOllamaCall = 0;

function parseArgs(argv) {
  const args = {
    layer: null,
    period: null,
    resume: false,
    status: false,
    force: false,
    all: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--layer") args.layer = String(argv[++i] || "").trim();
    else if (a === "--period") args.period = String(argv[++i] || "").trim();
    else if (a === "--resume") args.resume = true;
    else if (a === "--status") args.status = true;
    else if (a === "--force") args.force = true;
    else if (a === "--all") args.all = true;
  }
  return args;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleOllama() {
  const now = Date.now();
  const waitMs = Math.max(0, 2000 - (now - lastOllamaCall));
  if (waitMs > 0) await sleep(waitMs);
  lastOllamaCall = Date.now();
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

function loadTreeIndividuals() {
  const jsonPath = getLatestConvertedJsonPath();
  const payload = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  return Array.isArray(payload?.individuals) ? payload.individuals : [];
}

function resolveTargets(config, layerArg) {
  const scopes = config?.scopes || {};
  const all = [
    ...(Array.isArray(scopes.world) ? scopes.world.map((scope) => ({ layer: "world", scope })) : []),
    ...(Array.isArray(scopes.country) ? scopes.country.map((scope) => ({ layer: "country", scope })) : []),
    ...(Array.isArray(scopes.region) ? scopes.region.map((scope) => ({ layer: "region", scope })) : []),
  ];

  if (!layerArg) return all;
  return all.filter((t) => t.layer.toLowerCase() === layerArg.toLowerCase() || t.scope.toLowerCase() === layerArg.toLowerCase());
}

function generatedPath(target, period) {
  if (target.layer === "world") return path.join(contextRoot, "world", `${period}.json`);
  if (target.layer === "country") return path.join(contextRoot, "country", target.scope, `${period}.json`);
  if (target.layer === "region") return path.join(contextRoot, "region", target.scope, `${period}.json`);
  return path.join(contextRoot, "local", target.scope, `${period}.json`);
}

function rawFactsPath(scope, period) {
  const rawPath = path.join(rawFactsRelativeRoot, `${scope}-${period}.json`);
  return path.join(projectRoot, rawPath);
}

function sourceAttribution(rawPayload) {
  const names = Array.from(
    new Set(
      (Array.isArray(rawPayload?.sources) ? rawPayload.sources : [])
        .map((item) => String(item?.sourceName || "").trim())
        .filter(Boolean),
    ),
  );
  return names;
}

function buildSynthesisPrompt({ period, scope, ageContext, rawFacts, variantN }) {
  const sources = Array.isArray(rawFacts?.sources) ? rawFacts.sources : [];
  const nonOwidFacts = sources.filter((f) => String(f?.sourceId || "") !== "our_world_in_data");
  const stats = rawFacts?.statistics || {};

  let angleText =
    "Focus on the period conditions and keep details grounded in the provided evidence.";
  let statText = "No dedicated statistics available for this variant.";
  let factPool = nonOwidFacts;

  if (ageContext === "birth") {
    angleText =
      "What was the physical world like? Focus on environment, health, daily survival, and what a newborn would enter the world into.";
    statText = Number.isFinite(stats.lifeExpectancy)
      ? `Use this health context if relevant: lifeExpectancy=${stats.lifeExpectancy}.`
      : "No life expectancy stat available.";
    factPool = [...nonOwidFacts.filter((f) => String(f?.type || "").toLowerCase() === "statistic"), ...nonOwidFacts];
  } else if (ageContext === "childhood/adult") {
    angleText =
      "What was society and economy like? Focus on work, trade, social structures, and how people made a living.";
    statText = [
      Number.isFinite(stats.literacyRate) ? `literacyRate=${stats.literacyRate}` : null,
      Number.isFinite(stats.gdpPerCapita) ? `gdpPerCapita=${stats.gdpPerCapita}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    if (!statText) statText = "No literacy/economic stats available.";
  } else if (ageContext === "late/general") {
    angleText =
      "What major changes were happening? Focus on political events, technological changes, migrations, and conflicts shaping the next generation.";
    const eventLines = sources
      .slice(0, 8)
      .map((f) => `${f.title || "Untitled"} (${f.year || "n/a"})`)
      .filter(Boolean);
    statText = eventLines.length ? `Key events to prioritize: ${eventLines.join("; ")}` : "No key event lines available.";
  }

  const factLines = factPool.length
    ? factPool
        .slice(0, 18)
        .map((f, idx) => `- [${idx + 1}] ${f.title || "Untitled"} (${f.year || "n/a"}) [${f.sourceName}]: ${String(f.text || "").slice(0, 240)}`)
        .join("\n")
    : "- No source facts available";

  return `
You are rewriting verified historical facts for a family history book.
You MUST use only the facts below. Do not add any facts not provided.

PERIOD: ${period}
SCOPE: ${scope}
AGE CONTEXT: ${ageContext}
VARIANT: ${variantN} of 3
ANGLE:
${angleText}

VERIFIED FACTS:
${factLines}

SUPPORTING CONTEXT:
${statText}

WRITE:
- Exactly 2-3 warm, accessible sentences.
- Keep factual meaning and timeline intact.
- No invented names, events, or numbers.
- Do NOT repeat the same facts used in the other variants. Find a different angle from the source material provided.
- Maximum 80 words.
`.trim();
}

async function synthesizeVariant(input) {
  const prompt = buildSynthesisPrompt(input);
  await throttleOllama();
  const url = `${OLLAMA_BASE_URL.replace(/\/$/, "")}/api/generate`;
  try {
    const res = await axios.post(url, { model: OLLAMA_MODEL, prompt, stream: false }, { timeout: 90_000 });
    const text = String(res?.data?.response || "").replace(/\s+/g, " ").trim();
    return {
      id: `${input.scope}-${input.period}-v${input.variantN}`,
      text,
      ageContext: input.ageContext,
      tags: [input.scope, input.ageContext],
    };
  } catch {
    return {
      id: `${input.scope}-${input.period}-v${input.variantN}`,
      text: "",
      ageContext: input.ageContext,
      tags: [input.scope, input.ageContext],
    };
  }
}

function parsePeriod(period) {
  const [a, b] = String(period).split("-");
  return { startYear: Number(a), endYear: Number(b) };
}

function ensureRawFactsOrFetch(target, period, args) {
  const rawPath = rawFactsPath(target.scope, period);
  if (fs.existsSync(rawPath) && !args.force) return Promise.resolve();
  return runFetchSources({
    auto: true,
    resume: !args.force,
    layer: target.scope,
    period,
    force: args.force,
  });
}

function buildStatusReport(config, periods) {
  const targets = resolveTargets(config, null);
  let rawCount = 0;
  let generatedCount = 0;
  for (const target of targets) {
    for (const period of periods) {
      if (fs.existsSync(rawFactsPath(target.scope, period))) rawCount += 1;
      if (fs.existsSync(generatedPath(target, period))) generatedCount += 1;
    }
  }

  const total = targets.length * periods.length;
  return {
    generatedAt: new Date().toISOString(),
    totalExpected: total,
    rawFactsFiles: rawCount,
    generatedContextFiles: generatedCount,
  };
}

function cleanupGeneratedTargets(targets, periods) {
  for (const target of targets) {
    for (const period of periods) {
      const p = generatedPath(target, period);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
}

function mapFallback(target) {
  if (target.layer === "region") {
    return [target.scope, "USA", "global"];
  }
  if (target.layer === "country") {
    return [target.scope, "global"];
  }
  return ["global"];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = readContextConfig();
  const individuals = loadTreeIndividuals();
  const { min, max } = determineYearRange(individuals);
  let periods = buildPeriods(min, max);
  if (args.period) periods = periods.filter((p) => p === args.period);
  if (!periods.length) throw new Error("No periods selected for build.");

  if (args.status) {
    const status = buildStatusReport(config, periods);
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  const targets = args.all ? resolveTargets(config, null) : resolveTargets(config, args.layer);
  if (!targets.length) throw new Error("No target layers/scopes selected.");

  if (args.force) cleanupGeneratedTargets(targets, periods);

  let totalJobs = targets.length * periods.length;
  let completed = 0;
  let built = 0;

  for (const target of targets) {
    for (const period of periods) {
      const outPath = generatedPath(target, period);
      ensureDir(path.dirname(outPath));
      if (args.resume && !args.force && fs.existsSync(outPath)) {
        completed += 1;
        continue;
      }

      await ensureRawFactsOrFetch(target, period, args);
      let rawPath = rawFactsPath(target.scope, period);

      if (!fs.existsSync(rawPath)) {
        const chain = mapFallback(target);
        console.log(`Context fallback: ${chain.join(" -> ")}`);
        for (const scope of chain) {
          const candidate = rawFactsPath(scope, period);
          if (fs.existsSync(candidate)) {
            rawPath = candidate;
            break;
          }
        }
      }

      if (!fs.existsSync(rawPath)) {
        completed += 1;
        continue;
      }

      const rawPayload = JSON.parse(fs.readFileSync(rawPath, "utf-8"));
      const sourceIds = new Set(
        (Array.isArray(rawPayload?.sources) ? rawPayload.sources : [])
          .map((item) => String(item?.sourceId || "").trim())
          .filter(Boolean),
      );
      const owidOnly = sourceIds.size === 1 && sourceIds.has("our_world_in_data");
      if (owidOnly) {
        console.log(
          `⚠ Low quality context for ${target.scope} ${period}: only OWID data. Get free API keys:\nDPLA: dp.la/info/developers/codex\nEuropeana: pro.europeana.eu/pages/get-api\nWHE: worldhistory.org/affiliate/api`,
        );
      }
      const variants = [];
      for (const variant of VARIANT_CONFIG) {
        variants.push(
          await synthesizeVariant({
            period,
            scope: target.scope,
            ageContext: variant.ageContext,
            variantN: variant.id,
            rawFacts: rawPayload,
          }),
        );
      }

      const { startYear, endYear } = parsePeriod(period);
      const validEvents = (Array.isArray(rawPayload?.sources) ? rawPayload.sources : []).filter(
        (item) => Number.isFinite(item?.year) && item.year >= startYear - 5 && item.year <= endYear + 5,
      );
      let keyEvents = validEvents
        .slice(0, 8)
        .map((item) => ({
          year: Number.isFinite(item?.year) ? item.year : startYear,
          event: item?.title || "Historical source",
          oneLiner: String(item?.text || "").split(/(?<=[.?!])\s+/)[0] || "",
        }));
      if (!keyEvents.length) {
        const stats = rawPayload?.statistics || {};
        const statEvents = [];
        if (Number.isFinite(stats.lifeExpectancy)) {
          statEvents.push({
            year: startYear,
            event: "Life expectancy",
            oneLiner: `Estimated life expectancy was ${stats.lifeExpectancy}.`,
          });
        }
        if (Number.isFinite(stats.literacyRate)) {
          statEvents.push({
            year: startYear,
            event: "Literacy rate",
            oneLiner: `Estimated literacy rate was ${stats.literacyRate}.`,
          });
        }
        if (Number.isFinite(stats.gdpPerCapita)) {
          statEvents.push({
            year: startYear,
            event: "GDP per capita",
            oneLiner: `Estimated GDP per capita was ${stats.gdpPerCapita}.`,
          });
        }
        keyEvents = statEvents;
      }

      const payload = {
        period,
        layer: target.layer,
        scope: target.scope,
        generatedAt: new Date().toISOString(),
        generatedBy: `ollama/${OLLAMA_MODEL}`,
        variants,
        keyEvents,
        attributions: sourceAttribution(rawPayload),
        ...(owidOnly
          ? {
              generationQuality:
                "low — only statistical data available, no primary sources. Add API keys to improve quality.",
            }
          : {}),
      };

      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
      built += 1;
      completed += 1;

      if (completed % 10 === 0 || completed === totalJobs) {
        console.log(`Built ${completed}/${totalJobs} periods | Layer: ${target.scope} | Current: ${period}...`);
      }
    }
  }

  const index = {
    generatedAt: new Date().toISOString(),
    yearRange: { min, max },
    layers: Array.from(new Set(targets.map((t) => t.scope))),
    periodsGenerated: built,
    totalVariants: built * VARIANT_CONFIG.length,
  };
  fs.writeFileSync(path.join(contextRoot, "index.json"), JSON.stringify(index, null, 2));

  console.log(`Context synthesis complete. Generated/updated files: ${built}`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
