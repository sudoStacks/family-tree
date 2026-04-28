import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "../../..");

export const WIKIMEDIA_USER_AGENT =
  "family-tree-book-generator/1.0 (github.com/sudostacks/family-tree; genealogy research tool)";

export const sourceCacheRoot = path.join(projectRoot, "data", "historical-context", ".source-cache");
export const owidDataRoot = path.join(projectRoot, "data", "historical-context", ".owid-data");

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function scopeQuery(scope, startYear, endYear) {
  return `${scope} ${startYear} ${endYear}`.trim();
}

export function sourceCachePath(sourceId, cacheKey) {
  ensureDir(sourceCacheRoot);
  return path.join(sourceCacheRoot, `${slug(sourceId)}-${slug(cacheKey)}.json`);
}

export function readCache(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

export function writeCache(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

export async function httpGet(url, options = {}) {
  return axios.get(url, {
    timeout: options.timeout ?? 12_000,
    headers: {
      "User-Agent": WIKIMEDIA_USER_AGENT,
      Accept: "application/json",
      ...(options.headers || {}),
    },
    params: options.params,
  });
}

export function normalizeItem({
  sourceId,
  sourceName,
  sourceUrl,
  title,
  text,
  year,
  type,
  license,
  attribution,
}) {
  return {
    sourceId,
    sourceName,
    sourceUrl,
    title: String(title || "").trim(),
    text: String(text || "").replace(/\s+/g, " ").trim(),
    year: Number.isFinite(Number(year)) ? Number(year) : null,
    type: String(type || "article"),
    license: license || null,
    attribution: attribution || null,
  };
}

export function firstSentences(text, max = 3) {
  const parts = String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.?!])\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.slice(0, max).join(" ");
}

export function extractYear(text, fallback = null) {
  const match = String(text || "").match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  if (match) return Number(match[1]);
  return Number.isFinite(fallback) ? fallback : null;
}

export function csvParse(text) {
  const rows = String(text || "").split(/\r?\n/).filter(Boolean);
  if (!rows.length) return [];
  const header = rows[0].split(",").map((h) => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const cols = rows[i].split(",");
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = (cols[j] || "").trim();
    out.push(row);
  }
  return out;
}
