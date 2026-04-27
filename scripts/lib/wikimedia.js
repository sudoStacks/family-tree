import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "../..");
let loggedResponseShape = false;

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
  return path.join(projectRoot, "data", "image-cache", `${name}.jpg`);
}

export async function getCachedOrFetchCommonsImage(query) {
  const cachePath = imageCachePath(query);
  if (fs.existsSync(cachePath)) return { cachePath, metadata: null, source: "cache" };

  ensureDir(path.join(projectRoot, "data", "image-cache"));
  ensureDir(path.dirname(cachePath));

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
    res = await axios.get(url, { timeout: 10_000 });
  } catch (error) {
    console.log("Wikimedia error:", error?.message || String(error));
    return { cachePath: null, metadata: null, source: "error" };
  }

  if (!loggedResponseShape) {
    loggedResponseShape = true;
    try {
      console.log("Raw Wikimedia response keys:", Object.keys(res?.data || {}));
    } catch {
      // ignore
    }
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
      const licenseOk = /public domain|cc/i.test(ext);
      const landscape = width > height;
      const historicHint = /historic|old/i.test(title + " " + desc);
      return {
        title,
        thumb,
        width,
        height,
        license: ext || null,
        attribution: info?.extmetadata?.Attribution?.value || info?.extmetadata?.Artist?.value || null,
        licenseUrl: info?.extmetadata?.LicenseUrl?.value || null,
        score: (licenseOk ? 3 : 0) + (landscape ? 2 : 0) + (historicHint ? 1 : 0),
        isSvg,
      };
    })
    .filter(Boolean)
    .filter((c) => c.thumb && !c.isSvg)
    .sort((a, b) => b.score - a.score);

  console.log("Wikimedia results:", candidates.length, "images");

  const best = candidates[0] || null;
  if (!best) return { cachePath: null, metadata: null, source: "none" };

  try {
    const img = await axios.get(best.thumb, { responseType: "arraybuffer", timeout: 10_000 });
    fs.writeFileSync(cachePath, Buffer.from(img.data));
  } catch (error) {
    console.log("Wikimedia error:", error?.message || String(error));
    return { cachePath: null, metadata: best, source: "download-error" };
  }
  return { cachePath, metadata: best, source: "wikimedia" };
}
