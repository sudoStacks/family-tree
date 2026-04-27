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
  const q = String(query || "").trim();
  const out = [q];
  const parts = q
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const state = parts.length >= 2 ? parts[parts.length - 2] : "";
  const county = parts.length >= 3 ? parts[parts.length - 3] : "";
  if (county && state) out.push(`${county} County, ${state}`);
  if (state) out.push(`${state} historical photograph`);
  return out.slice(0, 3);
}

function scoreCandidate(c, query) {
  const title = String(c?.title || "").toLowerCase();
  const desc = String(c?.desc || "").toLowerCase();
  const q = String(query || "").toLowerCase();
  const rejectKeywords = [
    "map",
    "logo",
    "icon",
    "flag",
    "coat of arms",
    "seal",
    "diagram",
    "chart",
    "symbol",
    "emblem",
    "locator",
    "outline",
    "blank",
    "svg",
  ];
  const preferredKeywords = [
    "photo",
    "photograph",
    "view",
    "street",
    "building",
    "church",
    "courthouse",
    "farm",
    "house",
    "historic",
    "old",
    "vintage",
    "portrait",
    "family",
    "downtown",
    "main street",
  ];

  const hasReject = rejectKeywords.some((k) => title.includes(k));
  const hasPreferred = preferredKeywords.some((k) => title.includes(k));
  let score = 0;
  if (c.width > c.height) score += 3;
  if (c.width >= 800) score += 2;
  if (hasPreferred) score += 2;
  if (hasReject) score -= 3;
  if (q && (desc.includes(q) || title.includes(q))) score += 1;
  return score;
}

async function searchCommons(query) {
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
    res = await axios.get(url, {
      timeout: 10_000,
      headers: {
        "User-Agent": WIKIMEDIA_USER_AGENT,
        Accept: "application/json",
      },
    });
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
      const isSvg = title.toLowerCase().endsWith(".svg");
      return {
        title,
        desc,
        thumb,
        width,
        height,
        license: ext || null,
        attribution: info?.extmetadata?.Attribution?.value || info?.extmetadata?.Artist?.value || null,
        licenseUrl: info?.extmetadata?.LicenseUrl?.value || null,
        isSvg,
      };
    })
    .filter(Boolean)
    .filter((c) => c.thumb && !c.isSvg && c.width >= 400)
    .map((c) => ({ ...c, score: scoreCandidate(c, query) }))
    .sort((a, b) => b.score - a.score);

  console.log("Wikimedia results:", candidates.length, "images");
  return candidates;
}

async function downloadImageWithMetadata(imageUrl) {
  const response = await axios.get(imageUrl, {
    responseType: "arraybuffer",
    timeout: 10_000,
    headers: {
      "User-Agent": WIKIMEDIA_USER_AGENT,
      Accept: "application/json",
    },
  });
  const contentType = response?.headers?.["content-type"] || "";
  const ext = detectExtension({ contentType, imageUrl });
  return {
    buffer: Buffer.from(response.data),
    ext,
    mimeType: String(contentType || `image/${ext === "jpg" ? "jpeg" : ext}`),
  };
}

export async function getCachedOrFetchCommonsImage(query) {
  cleanupUndefinedCacheFiles();
  if (!loggedCacheNote) {
    loggedCacheNote = true;
    console.log("Note: delete data/image-cache/ if images appear broken - cached files may have wrong extensions");
  }

  const basePath = imageCachePath(query);
  const existing = findExistingCachedPath(basePath);
  if (existing) {
    return { cachePath: existing.cachePath, metadata: null, source: "cache", ext: existing.ext, mimeType: existing.mimeType };
  }

  ensureDir(IMAGE_CACHE_DIR);
  ensureDir(path.dirname(basePath));

  const attempts = buildFallbackQueries(query);
  let selected = null;
  let selectedQuery = query;
  for (let index = 0; index < attempts.length; index++) {
    const attemptQuery = attempts[index];
    const candidates = await searchCommons(attemptQuery);
    if (index > 0) {
      console.log(`Wikimedia fallback (${index + 1}/3): ${attemptQuery} → ${candidates.length} images`);
    }
    const best = candidates[0] || null;
    if (best && best.score >= 0) {
      selected = best;
      selectedQuery = attemptQuery;
      break;
    }
  }

  if (!selected) return { cachePath: null, metadata: null, source: "none", ext: null, mimeType: null };

  console.log(`Wikimedia selected: ${selected.title} (score: ${selected.score})`);

  try {
    const downloaded = await downloadImageWithMetadata(selected.thumb);
    const finalCachePath = cachePathForExt(basePath, downloaded.ext);
    fs.writeFileSync(finalCachePath, downloaded.buffer);
    return {
      cachePath: finalCachePath,
      metadata: selected,
      source: selectedQuery === query ? "wikimedia" : "wikimedia-fallback",
      ext: downloaded.ext,
      mimeType: downloaded.mimeType,
      buffer: downloaded.buffer,
    };
  } catch (error) {
    console.log("Wikimedia error:", query, "-", error?.message || String(error));
    return { cachePath: null, metadata: selected, source: "download-error", ext: null, mimeType: null };
  }
}
