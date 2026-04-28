#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { runFetchSources } from "./fetch-context-sources.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const contextRoot = path.join(projectRoot, "data", "historical-context");
const rawFactsRoot = path.join(contextRoot, ".raw-facts");

function parseArgs(argv) {
  const args = { days: 90 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--days") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.days = n;
    }
  }
  return args;
}

function collectRawFactsFiles() {
  if (!fs.existsSync(rawFactsRoot)) return [];
  return fs
    .readdirSync(rawFactsRoot)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(rawFactsRoot, name));
}

function isOlderThan(dateValue, days) {
  const t = Date.parse(dateValue || "");
  if (!Number.isFinite(t)) return true;
  const ageMs = Date.now() - t;
  return ageMs > days * 24 * 60 * 60 * 1000;
}

function extractScopePeriod(filePath) {
  const base = path.basename(filePath, ".json");
  const m = base.match(/^(.*)-(\d{4}-\d{4})$/);
  if (!m) return null;
  return { scope: m[1], period: m[2] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const staleTargets = [];

  for (const filePath of collectRawFactsFiles()) {
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (!isOlderThan(payload?.fetchedAt, args.days)) continue;
      const parsed = extractScopePeriod(filePath);
      if (!parsed) continue;
      staleTargets.push(parsed);
    } catch {
      const parsed = extractScopePeriod(filePath);
      if (!parsed) continue;
      staleTargets.push(parsed);
    }
  }

  if (!staleTargets.length) {
    console.log(`No stale context raw-fact files older than ${args.days} days.`);
    return;
  }

  let refreshed = 0;
  for (const target of staleTargets) {
    await runFetchSources({
      auto: true,
      resume: false,
      layer: target.scope,
      period: target.period,
      force: true,
    });
    refreshed += 1;
  }

  console.log(`Refreshed ${refreshed} stale context period files.`);
  console.log("Run `npm run build-context -- --resume` to re-synthesize generated context files.");
}

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
