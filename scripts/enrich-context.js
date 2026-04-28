#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const contextRoot = path.join(projectRoot, "data", "historical-context");

const WIKIMEDIA_USER_AGENT =
  "family-tree-book-generator/1.0 (github.com/sudostacks/family-tree; genealogy research tool)";

const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

let lastOllamaAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttleOllama() {
  const now = Date.now();
  const waitMs = Math.max(0, 2000 - (now - lastOllamaAt));
  if (waitMs > 0) await sleep(waitMs);
  lastOllamaAt = Date.now();
}

function wordCount(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

function collectPeriodFiles(rootDir) {
  const files = [];
  if (!fs.existsSync(rootDir)) return files;
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      if (entry.name === "index.json" || entry.name === "quality-report.json") continue;
      files.push(full);
    }
  }
  return files;
}

function inferAgeContext(index) {
  if (index === 0) return "birth";
  if (index === 1) return "childhood/adult";
  return "late/general";
}

async function getWikipediaFacts(period, scope) {
  const query = `${scope} history ${period}`;
  const url =
    "https://en.wikipedia.org/w/api.php" +
    "?action=query" +
    "&list=search" +
    `&srsearch=${encodeURIComponent(query)}` +
    "&format=json" +
    "&srlimit=3";

  const res = await axios.get(url, {
    timeout: 10_000,
    headers: {
      "User-Agent": WIKIMEDIA_USER_AGENT,
      Accept: "application/json",
    },
  });

  const items = Array.isArray(res?.data?.query?.search) ? res.data.query.search : [];
  return items.map((it) => String(it?.snippet || "").replace(/<[^>]+>/g, "").trim()).filter(Boolean);
}

function buildPrompt({ period, scope, ageContext, facts, variantIndex }) {
  return `
You are contributing to a printed family history book.
Write EXACTLY 2-3 sentences of historical context.

TIME PERIOD: ${period}
GEOGRAPHIC SCOPE: ${scope}
LIFE STAGE THIS WILL DESCRIBE: ${ageContext}
VARIANT: ${variantIndex} of 3

GROUNDING FACTS FROM WIKIPEDIA:
${facts.length ? facts.map((f) => `- ${f}`).join("\n") : "- No grounding facts available"}

STRICT RULES:
- Only reference events in this period
- No named individuals
- No vague filler phrases
- Maximum 60 words
`.trim();
}

async function generateVariant({ period, scope, ageContext, variantIndex, facts }) {
  await throttleOllama();
  const url = `${OLLAMA_BASE_URL.replace(/\/$/, "")}/api/generate`;
  const prompt = buildPrompt({ period, scope, ageContext, facts, variantIndex });
  try {
    const res = await axios.post(url, { model: OLLAMA_MODEL, prompt, stream: false }, { timeout: 90_000 });
    const text = String(res?.data?.response || "").replace(/\s+/g, " ").trim();
    return {
      id: `${scope}-${period}-v${variantIndex}`,
      text,
      ageContext,
      tags: [scope, ageContext],
    };
  } catch {
    return {
      id: `${scope}-${period}-v${variantIndex}`,
      text: "",
      ageContext,
      tags: [scope, ageContext],
    };
  }
}

async function enrichFile(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const variants = Array.isArray(payload.variants) ? payload.variants : [];
  const needsExtra = variants.length < 3;
  const lowQuality = variants
    .map((v, idx) => ({ idx, words: wordCount(v?.text || "") }))
    .filter((x) => x.words > 0 && x.words < 30)
    .map((x) => x.idx);

  if (!needsExtra && lowQuality.length === 0) {
    return { filePath, changed: false, reason: null, regenerated: 0 };
  }

  const scope = String(payload.scope || "global");
  const period = String(payload.period || "");
  const facts = await getWikipediaFacts(period, scope);

  let regenerated = 0;

  for (const idx of lowQuality) {
    const ageContext = inferAgeContext(idx);
    variants[idx] = await generateVariant({ period, scope, ageContext, variantIndex: idx, facts });
    regenerated += 1;
  }

  for (let idx = variants.length; idx < 3; idx++) {
    const ageContext = inferAgeContext(idx);
    variants.push(await generateVariant({ period, scope, ageContext, variantIndex: idx, facts }));
    regenerated += 1;
  }

  payload.variants = variants;
  payload.generatedAt = new Date().toISOString();
  payload.generatedBy = `ollama/${OLLAMA_MODEL}`;

  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return {
    filePath,
    changed: true,
    reason: needsExtra ? "missing-variants" : "low-quality",
    regenerated,
  };
}

async function main() {
  const files = collectPeriodFiles(contextRoot);
  let changed = 0;
  let regeneratedTotal = 0;
  const lowQualityFiles = [];

  for (const filePath of files) {
    const result = await enrichFile(filePath);
    if (!result.changed) continue;
    changed += 1;
    regeneratedTotal += result.regenerated;
    lowQualityFiles.push({ file: path.relative(projectRoot, filePath), reason: result.reason, regenerated: result.regenerated });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    filesScanned: files.length,
    filesChanged: changed,
    variantsRegenerated: regeneratedTotal,
    details: lowQualityFiles,
  };

  fs.writeFileSync(path.join(contextRoot, "quality-report.json"), JSON.stringify(report, null, 2));
  console.log(`Context enrichment complete. Files changed: ${changed}, variants regenerated: ${regeneratedTotal}`);
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
