import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "../..");
const contextRoot = path.join(projectRoot, "data", "historical-context");
const personCacheRoot = path.join(contextRoot, ".person-cache");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function periodForYear(year) {
  if (!Number.isFinite(year)) return null;
  const start = Math.floor(year / 5) * 5;
  return `${start}-${start + 4}`;
}

function normalizeScope(scope) {
  return String(scope || "").trim();
}

function scopeFromPlace(place) {
  const parts = String(place || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const country = parts.length ? parts[parts.length - 1] : "";
  const region = parts.length > 1 ? parts[parts.length - 2] : "";
  return { country, region };
}

function hashToIndex(value, modulo) {
  if (!modulo || modulo <= 0) return 0;
  const s = String(value || "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return Math.abs(h) % modulo;
}

function candidatePaths({ layer, scope, period }) {
  const cleanScope = normalizeScope(scope);
  const wantedLayer = normalizeScope(layer).toLowerCase();

  const ordered = [];
  if (wantedLayer === "local") {
    ordered.push(path.join(contextRoot, "local", cleanScope, `${period}.json`));
    ordered.push(path.join(contextRoot, "region", cleanScope, `${period}.json`));
    ordered.push(path.join(contextRoot, "country", cleanScope, `${period}.json`));
  } else if (wantedLayer === "region") {
    ordered.push(path.join(contextRoot, "region", cleanScope, `${period}.json`));
    ordered.push(path.join(contextRoot, "country", cleanScope, `${period}.json`));
  } else if (wantedLayer === "country") {
    ordered.push(path.join(contextRoot, "country", cleanScope, `${period}.json`));
  }

  ordered.push(path.join(contextRoot, "world", `${period}.json`));
  return ordered;
}

export async function getContext(birthYear, layer, scope, personId = "") {
  const period = periodForYear(birthYear);
  if (!period) return "";

  for (const filePath of candidatePaths({ layer, scope, period })) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const variants = Array.isArray(payload?.variants) ? payload.variants : [];
      if (!variants.length) continue;
      const idx = hashToIndex(personId || `${layer}:${scope}:${period}`, variants.length);
      const text = String(variants[idx]?.text || variants[0]?.text || "").trim();
      if (text) return text;
    } catch {
      // ignore malformed file and keep falling back
    }
  }

  return "";
}

export async function getLifeStageContext(person) {
  const personId = String(person?.id || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  ensureDir(personCacheRoot);
  const cachePath = path.join(personCacheRoot, `${personId}.json`);

  if (fs.existsSync(cachePath)) {
    try {
      return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    } catch {
      // ignore broken cache
    }
  }

  const birthYear = person?.birth?.dateISO ? Number(String(person.birth.dateISO).slice(0, 4)) : null;
  const deathYear = person?.death?.dateISO ? Number(String(person.death.dateISO).slice(0, 4)) : null;
  if (!Number.isFinite(birthYear)) {
    const empty = { atBirth: "", atChildhood: "", atAdulthood: "", atLateLife: "" };
    fs.writeFileSync(cachePath, JSON.stringify(empty, null, 2));
    return empty;
  }

  const { country, region } = scopeFromPlace(person?.birth?.place || "");

  const result = {
    atBirth: await getContext(birthYear, "world", "global", person?.id),
    atChildhood: await getContext(birthYear + 10, "region", region, person?.id),
    atAdulthood: await getContext(birthYear + 20, "country", country, person?.id),
    atLateLife: await getContext(
      Number.isFinite(deathYear) ? deathYear - 10 : birthYear + 60,
      "world",
      "global",
      person?.id,
    ),
  };

  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  return result;
}
