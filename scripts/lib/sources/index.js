import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import * as worldHistoryEnc from "./world-history-enc.js";
import * as dpla from "./dpla.js";
import * as chroniclingAmerica from "./chronicling-america.js";
import * as europeana from "./europeana.js";
import * as ourWorldInData from "./our-world-in-data.js";
import * as locCollections from "./loc-collections.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "../../..");

const MODULES = {
  world_history_encyclopedia: worldHistoryEnc,
  dpla,
  chronicling_america: chroniclingAmerica,
  europeana,
  our_world_in_data: ourWorldInData,
  loc_collections: locCollections,
};

export function readContextConfig() {
  const p = path.join(projectRoot, "data", "context-config.json");
  const raw = fs.readFileSync(p, "utf-8");
  return JSON.parse(raw);
}

export function getEnabledSources(config = readContextConfig()) {
  const sources = Array.isArray(config?.sources) ? config.sources : [];
  return sources.filter((s) => s?.enabled && MODULES[s.id]);
}

export async function fetchFromSource(sourceConfig, scope, startYear, endYear) {
  const mod = MODULES[sourceConfig.id];
  if (!mod || typeof mod.fetch !== "function") return [];
  return mod.fetch(scope, startYear, endYear, {
    apiKey: sourceConfig.apiKey ? process.env[sourceConfig.apiKey] : null,
    sourceConfig,
  });
}

export { MODULES };
