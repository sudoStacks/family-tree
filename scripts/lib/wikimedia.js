import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "../..");

const WIKIMEDIA_USER_AGENT =
  "family-tree-book-generator/1.0 (github.com/sudostacks/family-tree; genealogy research tool)";
const IMAGE_CACHE_DIR = path.join(projectRoot, "data", "image-cache");
const ALLOWED_EXTS = new Set(["jpg", "png", "gif", "webp", "bmp"]);
let cleanedUndefinedCache = false;
let loggedCacheNote = false;
let lastWikimediaRequestAt = 0;
let globalCooldownUntil = 0;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFilename(value) {
  return String(value || "image")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function imageCachePath(query) {
  const name = sanitizeFilename(query) || "image";
  return path.join(IMAGE_CACHE_DIR, name);
}

function detectExtension({ contentType, imageUrl }) {
  const ct = String(contentType || "").toLowerCase();
  let ext = "jpg";
  if (ct.includes("image/jpeg")) ext = "jpg";
  else if (ct.includes("image/png")) ext = "png";
  else if (ct.includes("image/gif")) ext = "gif";
  else if (ct.includes("image/webp")) ext = "webp";
  else if (ct.includes("image/bmp")) ext = "bmp";

  const urlExt = String(imageUrl || "")
    .split("?")[0]
    .split(".")
    .pop()
    .toLowerCase();
  if (ALLOWED_EXTS.has(urlExt) || urlExt === "jpeg") {
    ext = urlExt === "jpeg" ? "jpg" : urlExt;
  }
  return ext;
}

function cachePathForExt(basePath, ext) {
  return `${basePath}.${ext}`;
}

function findExistingCachedPath(basePath) {
  for (const ext of ALLOWED_EXTS) {
    const p = cachePathForExt(basePath, ext);
    if (fs.existsSync(p)) return { cachePath: p, ext, mimeType: `image/${ext === "jpg" ? "jpeg" : ext}` };
  }
  return null;
}

function cleanupUndefinedCacheFiles() {
  if (cleanedUndefinedCache) return;
  cleanedUndefinedCache = true;
  ensureDir(IMAGE_CACHE_DIR);
  const files = fs.readdirSync(IMAGE_CACHE_DIR);
  for (const file of files) {
    if (file.endsWith(".undefined")) {
      try {
        fs.unlinkSync(path.join(IMAGE_CACHE_DIR, file));
      } catch {
        // ignore cleanup failures
      }
    }
  }
}

function buildFallbackQueries(query) {
  const original = String(query || "").trim();
  const queries = [original];

  const noHistoric = original.replace(/\s*historic\s*/i, " ").replace(/\s+/g, " ").trim();
  if (noHistoric) queries.push(noHistoric);

  const base = noHistoric.replace(/\s+county\s+/i, " ").replace(/\s+/g, " ").trim();
  if (base) {
    queries.push(`${base} photograph`);
    queries.push(`${base} courthouse`);
    queries.push(`${base} downtown`);
    queries.push(`${base} street`);
  }

  const parts = original.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
  const stateWords = ["Indiana", "Ohio", "Illinois", "Pennsylvania", "Virginia", "Kentucky"];
  const state = parts.find((p) => stateWords.includes(p));
  if (state) {
    queries.push(`${state} pioneer farm photograph`);
    queries.push(`${state} historical photograph`);
  }

  return Array.from(new Set(queries)).slice(0, 5);
}

function extractYear(text) {
  const matches = String(text || "").match(/\b(1[6-9]\d{2}|20\d{2})\b/g);
  if (!matches || matches.length === 0) return null;
  return Number(matches[0]);
}

async function enforceWikimediaRateLimit() {
  const current = Date.now();
  if (current < globalCooldownUntil) {
    await new Promise((resolve) => setTimeout(resolve, globalCooldownUntil - current));
  }
  const now = Date.now();
  const elapsed = now - lastWikimediaRequestAt;
  const minGapMs = 2_000;
  if (elapsed < minGapMs) {
    await new Promise((resolve) => setTimeout(resolve, minGapMs - elapsed));
  }
  lastWikimediaRequestAt = Date.now();
}

async function wikimediaGetWithBackoff(url, query, responseType = "json") {
  const delaysMs = [0, 10_000, 30_000, 60_000];
  let lastError = null;
  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    if (delaysMs[attempt] > 0) {
      console.log(`Wikimedia rate limited for ${query}, waiting ${Math.round(delaysMs[attempt] / 1000)}s...`);
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
    }
    try {
      await enforceWikimediaRateLimit();
      return await axios.get(url, {
        responseType,
        timeout: 10_000,
        headers: {
          "User-Agent": WIKIMEDIA_USER_AGENT,
          Accept: "application/json",
        },
      });
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      if (status !== 429) break;
      globalCooldownUntil = Date.now() + 120_000;
    }
  }
  throw lastError || new Error("Wikimedia request failed");
}

function stripHtml(value) {
  return String(value || "").replace(/<[^>]*>/g, "").trim();
}

function extractQueryKeywords(query) {
  const stopWords = new Set(["county", "historic", "historical", "city", "town", "state", "usa", "united", "states", "the", "of", "and"]);
  return String(query || "")
    .split(/[^A-Za-z0-9]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter((x) => x.length >= 3)
    .filter((x) => !stopWords.has(x.toLowerCase()));
}

function storyDecision({ candidate, query, birthYear }) {
  const title = String(candidate?.title || "");
  const titleLower = title.toLowerCase();
  const desc = String(candidate?.desc || "");
  const descLower = desc.toLowerCase();
  const source = String(candidate?.source || "").toLowerCase();
  const artist = String(candidate?.artist || "").toLowerCase();
  const url = String(candidate?.thumb || "").toLowerCase();
  const queryLower = String(query || "").toLowerCase();

  const skip = (reason) => ({ keep: false, score: -999, reason });

  // HARD REJECTS
  const titleNoPrefix = title.replace(/^file:/i, "").trim();
  if (/^[A-Z]{1,3}[\s.]?\d/.test(titleNoPrefix)) return skip("book spine/call number");
  if (titleLower.includes("copy 1") || titleLower.includes("copy 2")) return skip("library copy label");
  if (titleLower.includes("blank page") || titleLower.includes("empty") || titleLower.includes("back cover")) {
    return skip("blank/cover scan");
  }
  if (candidate.width < 100 || candidate.height < 100) return skip("too small/icon-sized");
  if (url.endsWith(".svg") || titleLower.endsWith(".svg")) return skip("svg");
  if (url.endsWith(".pdf") || titleLower.endsWith(".pdf")) return skip("pdf");
  if (url.endsWith(".tif") || url.endsWith(".tiff") || titleLower.endsWith(".tif") || titleLower.endsWith(".tiff")) {
    return skip("tiff");
  }
  if (String(candidate?.mimeType || "").toLowerCase().includes("application/pdf")) return skip("pdf mime");

  const archiveSource = /uc-nrlf|hathitrust|internet archive/.test(`${source} ${artist}`);
  const looksLikeBookTitle = /volume|vol\.|novel|poems|catalog|transactions|proceedings|copy|book/i.test(titleNoPrefix);
  if (archiveSource && looksLikeBookTitle) return skip("book cover scan source");
  if (/watershed|drain|soil survey|gazetteer|business directory|encyclopedia|cyclopedia|proceedings|quarterly|academy of science/i.test(`${title} ${desc}`)) {
    return skip("document/archive text");
  }

  let score = 0;

  // Place photos and contextual architecture/infrastructure
  const placeStoryKeywords = [
    "courthouse",
    "court house",
    "main street",
    "downtown",
    "aerial view",
    "bird's eye",
    "street view",
    "historic district",
    "old town",
    "church",
    "farm",
    "farmhouse",
    "barn",
    "bridge",
    "railroad",
    "depot",
    "station",
    "school",
    "cemetery",
    "graveyard",
    "hotel",
    "mill",
    "factory",
    "store",
  ];
  for (const k of placeStoryKeywords) {
    if (titleLower.includes(k) || descLower.includes(k)) score += 4;
  }

  // Historical photo hints
  const historicalHints = ["photograph", "photo", "portrait", "circa", "ca.", "c.", "18", "19"];
  for (const k of historicalHints) {
    if (titleLower.includes(k) || descLower.includes(k)) score += 3;
  }

  // Maps: keep positively unless clearly modern
  const mapHints = ["map", "atlas", "plat", "survey", "county map"];
  const modernMapHints = ["openstreetmap", "google", "satellite", "gps"];
  const isMap = mapHints.some((k) => titleLower.includes(k) || descLower.includes(k));
  const isModernMap = modernMapHints.some((k) => titleLower.includes(k) || descLower.includes(k));
  if (isMap && isModernMap) return skip("modern map");
  if (isMap) score += 2;

  // Seal / coat of arms: keep only if place-specific
  const civicIdentity = ["seal", "coat of arms", "emblem"];
  const hasCivicIdentity = civicIdentity.some((k) => titleLower.includes(k) || descLower.includes(k));
  if (hasCivicIdentity) {
    if (queryLower && (titleLower.includes(queryLower) || descLower.includes(queryLower))) score += 1;
    else return skip("generic heraldry");
  }

  // Newspapers / documents: keep if dated
  const docHints = ["newspaper", "front page", "gazette", "herald", "deed", "certificate", "record"];
  const isDocument = docHints.some((k) => titleLower.includes(k) || descLower.includes(k));
  if (isDocument) {
    const y = extractYear(`${title} ${desc}`);
    if (y !== null) score += 2;
  }

  // Bonuses / penalties
  if (url.endsWith(".jpg") || url.endsWith(".jpeg")) score += 5;
  else if (url.endsWith(".png")) score += 5;
  else if (url.endsWith(".webp") || url.endsWith(".gif")) score += 3;

  if (candidate.width > candidate.height) score += 3;
  if (candidate.width >= 800) score += 2;
  if (queryLower && (titleLower.includes(queryLower) || descLower.includes(queryLower))) score += 2;
  const queryKeywords = extractQueryKeywords(query);
  if (queryKeywords.length) {
    const titleMatchCount = queryKeywords.filter((k) => titleLower.includes(k.toLowerCase())).length;
    if (titleMatchCount > 0) score += 3;
  }
  if (/\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(titleNoPrefix) && !/(county|city|town|street|school|courthouse|church|depot|railroad)/i.test(titleNoPrefix)) {
    score -= 2;
  }
  if (birthYear && Number.isFinite(birthYear)) {
    const eventYear = extractYear(`${title} ${desc}`);
    if (eventYear !== null && Math.abs(eventYear - birthYear) <= 50) score += 1;
  }
  const isPortraitPhoto = titleLower.includes("portrait") || descLower.includes("portrait");
  if (candidate.height > candidate.width && !isPortraitPhoto) score -= 2;
  if (candidate.width < 300) score -= 1;

  if (score <= 0) return skip("score<=0");
  return { keep: true, score, reason: "story-relevant" };
}

async function searchCommons(query, { birthYear = null, placeName = null } = {}) {
  const url =
    "https://commons.wikimedia.org/w/api.php" +
    "?action=query" +
    "&generator=search" +
    `&gsrsearch=${encodeURIComponent(`${query} historical`)}` +
    "&gsrnamespace=6" +
    "&prop=imageinfo" +
    "&iiprop=url|size|extmetadata" +
    "&iiurlwidth=800" +
    "&format=json";

  console.log("Wikimedia search:", query);
  let res;
  try {
    res = await wikimediaGetWithBackoff(url, query, "json");
  } catch (error) {
    console.log("Wikimedia error:", query, "-", error?.message || String(error));
    return [];
  }

  const pages = res?.data?.query?.pages ? Object.values(res.data.query.pages) : [];

  const candidates = pages
    .map((p) => {
      const info = Array.isArray(p?.imageinfo) ? p.imageinfo[0] : null;
      if (!info) return null;
      const thumb = info?.thumburl || null;
      const width = info?.thumbwidth || info?.width || 0;
      const height = info?.thumbheight || info?.height || 0;
      const ext = String(info?.extmetadata?.LicenseShortName?.value || "");
      const title = String(p?.title || "");
      const desc = String(info?.extmetadata?.ImageDescription?.value || "");
      const source = String(info?.extmetadata?.Source?.value || "");
      const artist = String(info?.extmetadata?.Artist?.value || "");
      const mimeType = String(info?.mime || info?.mediatype || info?.extmetadata?.MIMEType?.value || "");
      const isSvg = title.toLowerCase().endsWith(".svg");
      return {
        title,
        desc,
        source,
        artist,
        thumb,
        width,
        height,
        license: ext || null,
        attribution: info?.extmetadata?.Attribution?.value || info?.extmetadata?.Artist?.value || null,
        licenseUrl: info?.extmetadata?.LicenseUrl?.value || null,
        mimeType,
        isSvg,
      };
    })
    .filter(Boolean)
    .filter((c) => c.thumb && !c.isSvg);

  const kept = [];
  for (const candidate of candidates) {
    const decision = storyDecision({
      candidate,
      query: placeName || query,
      birthYear,
    });
    if (decision.keep) {
      const withScore = { ...candidate, score: decision.score };
      kept.push(withScore);
      console.log(`[KEEP score=${decision.score}] ${candidate.title}`);
    } else {
      console.log(`[SKIP ${decision.reason}] ${candidate.title}`);
    }
  }

  kept.sort((a, b) => b.score - a.score);
  console.log("Wikimedia results:", kept.length, "images");
  return kept;
}

async function downloadImageWithMetadata(imageUrl) {
  const response = await wikimediaGetWithBackoff(imageUrl, imageUrl, "arraybuffer");
  const contentType = response?.headers?.["content-type"] || "";
  const ext = detectExtension({ contentType, imageUrl });
  return {
    buffer: Buffer.from(response.data),
    ext,
    mimeType: String(contentType || `image/${ext === "jpg" ? "jpeg" : ext}`),
  };
}

export async function getCachedOrFetchCommonsImage(query, options = {}) {
  cleanupUndefinedCacheFiles();
  if (!loggedCacheNote) {
    loggedCacheNote = true;
    console.log("Note: delete data/image-cache/ if images appear broken - cached files may have wrong extensions");
  }

  const basePath = imageCachePath(query);
  const existing = findExistingCachedPath(basePath);
  if (existing) {
    try {
      const buffer = fs.readFileSync(existing.cachePath);
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
      return { cachePath: existing.cachePath, metadata: null, source: "cache", ext: existing.ext, mimeType: existing.mimeType, buffer };
    } catch {
      return null;
    }
  }

  ensureDir(IMAGE_CACHE_DIR);
  ensureDir(path.dirname(basePath));

  const attempts = buildFallbackQueries(query);
  let selected = null;
  let selectedQuery = query;
  const totalAttempts = Math.min(attempts.length, 5);
  for (let index = 0; index < totalAttempts; index++) {
    const attemptQuery = attempts[index];
    const candidates = await searchCommons(attemptQuery, {
      birthYear: options?.birthYear ?? null,
      placeName: query,
    });
    console.log(`Wikimedia fallback (${index + 1}/${totalAttempts}): ${attemptQuery} → ${candidates.length} images`);
    const best = candidates[0] || null;
    if (best && best.score > 0) {
      selected = best;
      selectedQuery = attemptQuery;
      break;
    }
  }

  if (!selected) return null;

  console.log(`Wikimedia selected: ${selected.title} (score: ${selected.score})`);

  try {
    const downloaded = await downloadImageWithMetadata(selected.thumb);
    if (!downloaded?.buffer || !Buffer.isBuffer(downloaded.buffer) || downloaded.buffer.length === 0) return null;
    const finalCachePath = cachePathForExt(basePath, downloaded.ext);
    fs.writeFileSync(finalCachePath, downloaded.buffer);
    return {
      cachePath: finalCachePath,
      metadata: {
        ...selected,
        title: String(selected?.title || "").replace(/^File:/i, ""),
        license: selected?.license || "unknown",
        attribution: stripHtml(selected?.attribution || selected?.artist || ""),
      },
      source: selectedQuery === query ? "wikimedia" : "wikimedia-fallback",
      ext: downloaded.ext,
      mimeType: downloaded.mimeType,
      buffer: downloaded.buffer,
      title: String(selected?.title || "").replace(/^File:/i, ""),
      url: selected?.thumb || "",
      license: selected?.license || "unknown",
      attribution: stripHtml(selected?.attribution || selected?.artist || ""),
    };
  } catch (error) {
    console.log("Wikimedia error:", query, "-", error?.message || String(error));
    return null;
  }
}
