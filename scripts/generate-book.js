#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import dotenv from "dotenv";
import sharp from "sharp";
import { format } from "date-fns";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
  Packer,
} from "docx";

import { getLatestConvertedJsonPath } from "./_json-latest.js";
import { getNarrative } from "./lib/ai.js";
import { getCachedOrFetchCommonsImage } from "./lib/wikimedia.js";
import { detectFamilyHomelands, getPlaceImage, getPlaceSummary } from "./lib/places.js";
import { getLifeStageContext, getContext } from "./lib/context.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const PAGE_WIDTH_DXA = 12240;
const PAGE_HEIGHT_DXA = 15840;
const MARGIN_DXA = 1440;
const CONTENT_WIDTH_DXA = 9360;

function cleanName(raw) {
  if (!raw) return "";
  // Remove GEDCOM surname slashes: /Smith/ or /SMITH/
  return String(raw).replace(/\s*\/[^/]*\/\s*/g, " ").replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const args = {
    generation: null,
    surname: null,
    surnames: null,
    person: null,
    ancestors: 3,
    descendants: 3,
    includeSpouses: false,
    refresh: false,
    noImages: false,
    noAi: false,
    noPlaces: false,
    clearCache: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--generation") args.generation = Number(argv[i + 1] || ""), i++;
    else if (a === "--surname") args.surname = String(argv[i + 1] || ""), i++;
    else if (a === "--surnames") args.surnames = String(argv[i + 1] || ""), i++;
    else if (a === "--person") args.person = String(argv[i + 1] || ""), i++;
    else if (a === "--ancestors") args.ancestors = Math.min(6, Math.max(0, Number(argv[i + 1] || 3))), i++;
    else if (a === "--descendants") args.descendants = Math.min(6, Math.max(0, Number(argv[i + 1] || 3))), i++;
    else if (a === "--include-spouses") args.includeSpouses = true;
    else if (a === "--refresh") args.refresh = true;
    else if (a === "--no-images") args.noImages = true;
    else if (a === "--no-ai") args.noAi = true;
    else if (a === "--no-places") args.noPlaces = true;
    else if (a === "--clear-cache") args.clearCache = true;
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function yearFromISO(dateISO) {
  if (!dateISO || typeof dateISO !== "string") return null;
  const m = dateISO.match(/^(\d{4})-/);
  if (!m) return null;
  const year = Number(m[1]);
  return Number.isFinite(year) ? year : null;
}

function normalizeSurname(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9' -]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugifySurname(value) {
  return normalizeSurname(value).toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9'-]/g, "");
}

function displayName(person) {
  const full = cleanName(person?.name?.full);
  const surname = cleanName(person?.name?.surname);
  if (full) {
    const fullLower = full.toLowerCase();
    const surnameLower = surname.toLowerCase();
    if (surname && !fullLower.includes(surnameLower)) {
      return cleanName(`${full} ${surname}`);
    }
    return full;
  }
  const parts = [cleanName(person?.name?.given), surname].filter(Boolean);
  return cleanName(parts.join(" ")) || "Unknown";
}

function firstName(person) {
  const given = cleanName(person?.name?.given);
  return given.split(/\s+/).filter(Boolean)[0] || cleanName(displayName(person)).split(/\s+/)[0] || "They";
}

function placeParts(place) {
  return String(place || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function countryFromPlace(place) {
  const parts = placeParts(place);
  return parts.length ? parts[parts.length - 1] : "";
}

function stateFromPlace(place) {
  const parts = placeParts(place);
  return parts.length > 1 ? parts[parts.length - 2] : "";
}

function isLiving(person) {
  if (person?.living === true) return true;
  if (person?.living === false) return false;
  const birthISO = person?.birth?.dateISO ?? null;
  const deathISO = person?.death?.dateISO ?? null;
  const rawTags = person?.rawTags || {};
  const hasDeathTag =
    rawTags &&
    typeof rawTags === "object" &&
    Array.isArray(rawTags.DEAT) &&
    rawTags.DEAT.length > 0;
  return birthISO === null && deathISO === null && !hasDeathTag;
}

function completenessScore(person) {
  let score = 0;
  const hasBirthDate = Boolean(person?.birth?.dateISO);
  const hasBirthPlace = Boolean(person?.birth?.place);
  const hasDeathDate = Boolean(person?.death?.dateISO);
  const hasDeathPlace = Boolean(person?.death?.place);
  const hasFamilyLink =
    (Array.isArray(person?.familiesAsSpouse) && person.familiesAsSpouse.length > 0) ||
    (Array.isArray(person?.familiesAsChild) && person.familiesAsChild.length > 0);
  const hasSourceCitation =
    (Array.isArray(person?.birth?.sourceRefs) && person.birth.sourceRefs.length > 0) ||
    (Array.isArray(person?.death?.sourceRefs) && person.death.sourceRefs.length > 0) ||
    (Array.isArray(person?.sources) && person.sources.length > 0);

  if (hasBirthDate) score += 20;
  if (hasBirthPlace) score += 10;
  if (hasDeathDate || isLiving(person)) score += 20;
  if (hasDeathPlace) score += 10;
  if (hasFamilyLink) score += 20;
  if (hasSourceCitation) score += 20;
  return score;
}

function buildFooter({ surname }) {
  const title = surname ? `${surname} Family History` : "Family History";
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "Page ", font: "Arial", size: 20 }),
          new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 20 }),
          new TextRun({ text: ` — ${title}`, font: "Arial", size: 20 }),
        ],
      }),
    ],
  });
}

function heading(text, level) {
  const style = level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2;
  const size = level === 1 ? 36 : 28;
  const color = level === 1 ? "1F3864" : "2E75B6";
  return new Paragraph({
    heading: style,
    children: [new TextRun({ text, font: "Arial", size, bold: true, color })],
  });
}

function body(text) {
  return new Paragraph({
    style: "Normal",
    children: [
      new TextRun({
        text: String(text ?? ""),
        font: "Georgia",
        size: 22,
        color: "1a1a1a",
      }),
    ],
    spacing: { after: 160, line: 276 },
  });
}

function sectionLabel(text) {
  return new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: String(text || ""), font: "Arial", size: 20, bold: true, color: "1F3864" })],
  });
}

function captionText(text) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({ text: String(text || ""), font: "Arial", size: 18, italics: true, color: "666666" })],
  });
}

function divider() {
  return new Paragraph({
    border: {
      bottom: { style: BorderStyle.SINGLE, color: "2E75B6", size: 6, space: 2 },
    },
  });
}

function shadedBlock({ text, fill, borderColor }) {
  return new Paragraph({
    shading: { type: ShadingType.CLEAR, fill },
    border: borderColor
      ? { left: { style: BorderStyle.SINGLE, color: borderColor, size: 12, space: 6 } }
      : undefined,
    children: [new TextRun({ text, font: "Arial", size: 22 })],
    spacing: { line: 312, before: 120, after: 120 },
  });
}

function table2Col(rows) {
  const header = new TableRow({
    children: ["", ""].map(
      (_, idx) =>
        new TableCell({
          width: { size: idx === 0 ? 3744 : 5616, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: "1F3864" },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [new Paragraph({ children: [new TextRun({ text: "", color: "FFFFFF" })] })],
        }),
    ),
  });
  const bodyRows = rows.map((r, idx) => {
    const fill = idx % 2 === 0 ? "FFFFFF" : "F2F2F2";
    return new TableRow({
      children: [
        new TableCell({
          width: { size: 3744, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [new Paragraph({ children: [new TextRun({ text: r[0], font: "Arial", size: 22, bold: true })] })],
        }),
        new TableCell({
          width: { size: 5616, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [new Paragraph({ children: [new TextRun({ text: r[1], font: "Arial", size: 22 })] })],
        }),
      ],
    });
  });
  return new Table({
    columnWidths: [3744, 5616],
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    rows: [header, ...bodyRows],
  });
}

function pickMostCommon(values) {
  const m = new Map();
  for (const v of values) {
    if (!v) continue;
    m.set(v, (m.get(v) || 0) + 1);
  }
  const best = Array.from(m.entries()).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : "";
}

function medianBirthYearForPeople(people) {
  const years = (Array.isArray(people) ? people : [])
    .map((p) => yearFromISO(p?.birth?.dateISO))
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b);
  if (!years.length) return null;
  return years[Math.floor(years.length / 2)];
}

function generationFromBirthYear(year) {
  if (!Number.isFinite(year)) return null;
  if (year < 1750) return 1;
  if (year < 1800) return 2;
  if (year < 1850) return 3;
  if (year < 1900) return 4;
  if (year < 1950) return 5;
  if (year < 2000) return 6;
  return 7;
}

function generationRangeLabel(generationNumber) {
  const ranges = {
    1: "pre-1750",
    2: "1750 to 1799",
    3: "1800 to 1849",
    4: "1850 to 1899",
    5: "1900 to 1949",
    6: "1950 to 1999",
    7: "2000+",
  };
  return ranges[generationNumber] || "Unknown";
}

function buildGenerationMap({ individuals }) {
  const personById = new Map(individuals.filter((p) => p?.id).map((p) => [p.id, p]));
  const generation = new Map();
  for (const person of individuals) {
    const year = yearFromISO(person?.birth?.dateISO);
    const g = generationFromBirthYear(year);
    if (person?.id && g !== null) generation.set(person.id, g);
  }
  const maxGen = Math.max(0, ...Array.from(generation.values()));
  return { generation, maxGen, personById };
}

function lifeStageBulletsFromContext(ctx) {
  const lines = [ctx?.atBirth, ctx?.atChildhood, ctx?.atAdulthood, ctx?.atLateLife]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  return lines.slice(0, 5);
}

async function getUnusedSidebar(year, usedSet, seedBase) {
  if (!Number.isFinite(year)) return null;
  for (let v = 0; v < 3; v++) {
    const text = String(await getContext(year, "world", "global", `${seedBase}-v${v}`) || "").trim();
    if (!text) continue;
    if (!usedSet.has(text)) {
      usedSet.add(text);
      return text;
    }
  }
  return null;
}

async function findLocalPortrait(person) {
  // Local media path uses documents/by-person/{id}-{surname}-{given}/media/
  // We don't know the folder name here without reimplementing the exact slug rules;
  // so we scan by-person for a folder that starts with the pointer-stripped id.
  const id = String(person?.id || "").replace(/@/g, "");
  if (!id) return null;
  const byPerson = path.join(projectRoot, "documents", "by-person");
  if (!fs.existsSync(byPerson)) return null;
  const dirs = fs.readdirSync(byPerson).filter((d) => d.startsWith(`${id}-`));
  const mediaDir = dirs[0] ? path.join(byPerson, dirs[0], "media") : null;
  if (!mediaDir || !fs.existsSync(mediaDir)) return null;
  const files = fs
    .readdirSync(mediaDir)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => path.join(mediaDir, f));
  return files[0] || null;
}

async function imageRunFromFile(imagePath, extHint = null) {
  const input = fs.readFileSync(imagePath);
  const extFromPath = String(extHint || path.extname(imagePath || "")).replace(".", "").toLowerCase();
  const normalizedType = extFromPath === "jpeg" ? "jpg" : extFromPath;
  const imageType = ["jpg", "png", "gif", "webp", "bmp"].includes(normalizedType) ? normalizedType : "jpg";
  const resized = await sharp(input)
    .resize({ width: 800, withoutEnlargement: true })
    .toFormat(imageType === "jpg" ? "jpeg" : imageType)
    .toBuffer();
  return new ImageRun({
    data: resized,
    transformation: { width: 400, height: 300 },
    type: imageType,
  });
}

function imageTypeFromPath(imagePath, extHint = null) {
  const extFromPath = String(extHint || path.extname(imagePath || "")).replace(".", "").toLowerCase();
  const normalizedType = extFromPath === "jpeg" ? "jpg" : extFromPath;
  return ["jpg", "png", "gif", "webp", "bmp"].includes(normalizedType) ? normalizedType : "jpg";
}

async function buildImageParagraph(imagePath, extHint = null) {
  try {
    const buffer = await fs.promises.readFile(imagePath);
    const meta = await sharp(buffer).metadata();
    const maxWidth = 3000;
    const maxHeight = 2500;
    let width = meta.width || 200;
    let height = meta.height || 150;
    const scale = Math.min(maxWidth / width, maxHeight / height, 1);
    width = Math.round(width * scale * 9525);
    height = Math.round(height * scale * 9525);
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new ImageRun({
          data: buffer,
          transformation: { width, height },
          type: imageTypeFromPath(imagePath, extHint),
        }),
      ],
    });
  } catch (e) {
    console.log("Image embed failed:", e?.message || String(e));
    return null;
  }
}

function placeholderBox(text) {
  return new Table({
    columnWidths: [9360],
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 8, color: "2E75B6" },
              bottom: { style: BorderStyle.SINGLE, size: 8, color: "2E75B6" },
              left: { style: BorderStyle.SINGLE, size: 8, color: "2E75B6" },
              right: { style: BorderStyle.SINGLE, size: 8, color: "2E75B6" },
            },
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text, font: "Georgia", size: 28, italic: true, color: "666666" })],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function personConnectionsBox({ person, personById, familiesById }) {
  const lines = [];
  // Parents
  const famc = Array.isArray(person?.familiesAsChild) ? person.familiesAsChild : [];
  const parentNames = [];
  for (const fid of famc) {
    const fam = familiesById.get(fid);
    if (!fam) continue;
    const father = fam.husband ? personById.get(fam.husband) : null;
    const mother = fam.wife ? personById.get(fam.wife) : null;
    if (father) parentNames.push(displayName(father));
    if (mother) parentNames.push(displayName(mother));
    break;
  }
  if (parentNames.length) lines.push(`Parents: ${parentNames.join(" + ")}`);

  // Marriage + spouse(s)
  const fams = Array.isArray(person?.familiesAsSpouse) ? person.familiesAsSpouse : [];
  const marriageLines = [];
  if (fams.length) {
    for (const fid of fams) {
      const fam = familiesById.get(fid);
      if (!fam) continue;
      const spouseId = fam.husband === person.id ? fam.wife : fam.husband;
      const spouse = spouseId ? personById.get(spouseId) : null;
      if (spouse) {
        const spouseBirthYear = yearFromISO(spouse?.birth?.dateISO);
        const spouseDeathYear = yearFromISO(spouse?.death?.dateISO);
        marriageLines.push(`Married: ${displayName(spouse)} (${spouseBirthYear ?? "?"}-${spouseDeathYear ?? "?"})`);
      }
    }
  }
  if (marriageLines.length) lines.push(...marriageLines);

  // Children across all spouse families
  if (fams.length) {
    const childNames = [];
    for (const fid of fams) {
      const fam = familiesById.get(fid);
      if (!fam) continue;
      for (const cid of fam.children || []) {
        const child = personById.get(cid);
        if (child) childNames.push(displayName(child));
      }
    }
    if (childNames.length) lines.push(`Children: ${Array.from(new Set(childNames)).slice(0, 12).join(", ")}`);
  }

  const text = lines.length ? lines.join("  ") : "Family connections: (not enough data yet)";
  return shadedBlock({ text, fill: "F2F2F2" });
}

function relationshipSubtitle({ person, personById, familiesById }) {
  const famc = Array.isArray(person?.familiesAsChild) ? person.familiesAsChild : [];
  for (const fid of famc) {
    const fam = familiesById.get(fid);
    if (!fam) continue;
    const father = fam.husband ? personById.get(fam.husband) : null;
    const mother = fam.wife ? personById.get(fam.wife) : null;
    const fatherName = father ? displayName(father) : "";
    const motherName = mother ? displayName(mother) : "";
    if (fatherName || motherName) {
      const role = person?.sex === "M" ? "Son" : person?.sex === "F" ? "Daughter" : "Child";
      if (fatherName && motherName) return `${role} of ${fatherName} and ${motherName}`;
      if (fatherName) return `${role} of ${fatherName}`;
      return `${role} of ${motherName}`;
    }
  }

  const fams = Array.isArray(person?.familiesAsSpouse) ? person.familiesAsSpouse : [];
  for (const fid of fams) {
    const fam = familiesById.get(fid);
    if (!fam) continue;
    const spouseId = fam.husband === person?.id ? fam.wife : fam.husband;
    const spouse = spouseId ? personById.get(spouseId) : null;
    const spouseName = spouse ? displayName(spouse) : "";
    if (spouseName) {
      const role = person?.sex === "M" ? "Husband" : person?.sex === "F" ? "Wife" : "Spouse";
      return `${role} of ${spouseName}`;
    }
  }

  return null;
}

function levenshteinDistance(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  const dp = Array.from({ length: s.length + 1 }, () => Array(t.length + 1).fill(0));
  for (let i = 0; i <= s.length; i++) dp[i][0] = i;
  for (let j = 0; j <= t.length; j++) dp[0][j] = j;
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[s.length][t.length];
}

function findAnchorPerson(individuals, query) {
  const qRaw = String(query || "").trim();
  if (!qRaw) return { anchor: null, suggestions: [] };
  const byId = new Map((individuals || []).filter((p) => p?.id).map((p) => [p.id, p]));
  if (qRaw.startsWith("@") || /^P\d+$/i.test(qRaw)) {
    const id = qRaw.startsWith("@") ? qRaw : `@${qRaw.toUpperCase()}@`;
    const anchor = byId.get(id) || null;
    return { anchor, suggestions: [] };
  }

  const q = qRaw.toLowerCase();
  const exact = (individuals || []).find((p) => cleanName(p?.name?.full || "").toLowerCase() === q);
  if (exact) return { anchor: exact, suggestions: [] };

  const partial = (individuals || []).filter((p) => cleanName(p?.name?.full || "").toLowerCase().includes(q));
  if (partial.length === 1) return { anchor: partial[0], suggestions: [] };
  if (partial.length > 1) {
    const deceased = partial.filter((p) => !isLiving(p));
    const anchor = deceased[0] || partial[0];
    return { anchor, suggestions: partial.slice(0, 5) };
  }

  const scored = (individuals || [])
    .map((p) => {
      const n = cleanName(p?.name?.full || "").toLowerCase();
      return { p, d: levenshteinDistance(n, q) };
    })
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map((x) => x.p);
  return { anchor: null, suggestions: scored };
}

function getAncestors(personId, individuals, families, levels) {
  const result = new Map();
  const personById = new Map((individuals || []).map((p) => [p.id, p]));
  const familyById = new Map((families || []).map((f) => [f.id, f]));
  function traverse(id, level) {
    if (level < -levels) return;
    const person = personById.get(id);
    if (!person) return;
    if (!result.has(id) || level > result.get(id)) result.set(id, level);
    for (const famId of person.familiesAsChild || []) {
      const fam = familyById.get(famId);
      if (!fam) continue;
      if (fam.husband) traverse(fam.husband, level - 1);
      if (fam.wife) traverse(fam.wife, level - 1);
    }
  }
  traverse(personId, 0);
  return result;
}

function getDescendants(personId, individuals, families, levels, options = {}) {
  const includeSpouses = Boolean(options.includeSpouses);
  const result = new Map();
  const personById = new Map((individuals || []).map((p) => [p.id, p]));
  const familyById = new Map((families || []).map((f) => [f.id, f]));
  function traverse(id, level) {
    if (level > levels) return;
    const person = personById.get(id);
    if (!person) return;
    if (level > 0) result.set(id, level);
    for (const famId of person.familiesAsSpouse || []) {
      const fam = familyById.get(famId);
      if (!fam) continue;
      const spouseId = fam.husband === id ? fam.wife : fam.husband;
      if (includeSpouses && spouseId && level > 0 && !result.has(spouseId)) result.set(spouseId, level);
      for (const childId of fam.children || []) {
        if (!result.has(childId)) traverse(childId, level + 1);
      }
    }
  }
  traverse(personId, 0);
  return result;
}

function ancestorLevelLabel(level) {
  const map = { 1: "Parents", 2: "Grandparents", 3: "Great-Grandparents", 4: "2x Great-Grandparents", 5: "3x Great-Grandparents", 6: "4x Great-Grandparents" };
  return map[level] || `Ancestors Level ${level}`;
}

function descendantLevelLabel(level) {
  const map = { 1: "Children", 2: "Grandchildren", 3: "Great-Grandchildren", 4: "2x Great-Grandchildren", 5: "3x Great-Grandchildren", 6: "4x Great-Grandchildren" };
  return map[level] || `Descendants Level ${level}`;
}

function formatYears(person) {
  const b = person?.birth?.dateISO ? String(person.birth.dateISO).slice(0, 4) : "?";
  const d = person?.death?.dateISO
    ? String(person.death.dateISO).slice(0, 4)
    : person?.living === true
      ? "living"
      : "";
  return d ? `(${b}-${d})` : `(b.${b})`;
}

function buildAsciiTree({ anchor, ancestorsMap, descendantsMap, personById }) {
  const lines = [];

  // Ancestors (oldest first: most negative level to -1)
  const ancestorLevels = Array.from(new Set(Array.from(ancestorsMap.values()).filter((l) => l < 0))).sort((a, b) => a - b);
  for (const level of ancestorLevels) {
    const people = Array.from(ancestorsMap.entries())
      .filter(([, l]) => l === level)
      .map(([id]) => personById.get(id))
      .filter(Boolean)
      .sort((a, b) => (yearFromISO(a?.birth?.dateISO) || 9999) - (yearFromISO(b?.birth?.dateISO) || 9999));
    lines.push(ancestorLevelLabel(Math.abs(level)).toUpperCase());
    for (const p of people) lines.push(`  ${displayName(p)} ${formatYears(p)}`);
    lines.push("  |");
  }

  // Anchor
  lines.push("");
  lines.push(`>>> ${displayName(anchor).toUpperCase()} ${formatYears(anchor)} <<<`);
  lines.push("  |");

  // Descendants (nearest to furthest)
  const descendantLevels = Array.from(new Set(Array.from(descendantsMap.values()).filter((l) => l > 0))).sort((a, b) => a - b);
  for (const level of descendantLevels) {
    const people = Array.from(descendantsMap.entries())
      .filter(([, l]) => l === level)
      .map(([id]) => personById.get(id))
      .filter(Boolean)
      .sort((a, b) => (yearFromISO(a?.birth?.dateISO) || 9999) - (yearFromISO(b?.birth?.dateISO) || 9999));
    const deceased = people.filter((p) => p?.living !== true);
    const living = people.filter((p) => p?.living === true);
    lines.push(descendantLevelLabel(level).toUpperCase());
    for (const p of deceased) lines.push(`  ${displayName(p)} ${formatYears(p)}`);
    if (living.length > 0) lines.push(`  + ${living.length} living (names withheld)`);
  }

  return lines;
}

function bulletList(items, numbering) {
  return items.map(
    (t) =>
      new Paragraph({
        numbering: { reference: numbering, level: 0 },
        children: [new TextRun({ text: t, font: "Arial", size: 22 })],
      }),
  );
}

function parsePlaceComponents(place) {
  const parts = String(place || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);

  // Many genealogical place strings are "City, County, State, Country",
  // but may include additional locality parts. Prefer the LAST components.
  const country = parts.at(-1) || "";
  const state = parts.at(-2) || "";
  const county = parts.at(-3) || "";
  const city = parts.length >= 4 ? parts.slice(0, parts.length - 3).join(", ") : parts.at(0) || "";

  return { city, county, state, country };
}

function regionKeyFromComponents(components) {
  const country = String(components.country || "").trim();
  const state = String(components.state || "").trim();
  const cLower = country.toLowerCase();
  const isUsa = cLower === "usa" || cLower === "united states" || cLower === "united states of america";
  if (isUsa) return `USA|${state || "Unknown"}`;
  return `COUNTRY|${country || "Unknown"}`;
}

function regionDisplayName(regionKey, cityHint) {
  if (regionKey.startsWith("USA|")) {
    const state = regionKey.split("|")[1] || "Unknown";
    return cityHint ? `${cityHint}, ${state}, USA` : `${state}, USA`;
  }
  if (regionKey.startsWith("COUNTRY|")) {
    const country = regionKey.split("|")[1] || "Unknown";
    return cityHint ? `${cityHint}, ${country}` : `${country}`;
  }
  return regionKey;
}

function decadeFromYear(year) {
  if (!Number.isFinite(year)) return null;
  return Math.floor(year / 10) * 10;
}

function extractAllPlacesForPerson({ person, familiesById, personById }) {
  const places = [];

  if (person?.birth?.place) places.push(person.birth.place);

  // Marriage place(s) via familiesAsSpouse
  const fams = Array.isArray(person?.familiesAsSpouse) ? person.familiesAsSpouse : [];
  for (const fid of fams) {
    const fam = familiesById.get(fid);
    if (fam?.marriage?.place) places.push(fam.marriage.place);
  }

  // Residence events (prefer normalized converter output)
  const events = Array.isArray(person?.events) ? person.events : [];
  for (const e of events) {
    if (String(e?.type || "").toUpperCase() === "RESI" && e?.place) {
      places.push(e.place);
    }
  }

  // Residence in rawTags (fallback)
  const rawTags = person?.rawTags || {};
  const resi = Array.isArray(rawTags?.RESI) ? rawTags.RESI : [];
  for (const r of resi) {
    const tree = Array.isArray(r?.tree) ? r.tree : [];
    const plac = tree.find((t) => t?.tag === "PLAC")?.value;
    if (plac) places.push(plac);
  }

  return places;
}

function buildGenerationPlaceIndex({ people, familiesById, personById }) {
  const regionStats = new Map(); // regionKey -> { count, cities:Map, years:number[] }
  const regionPeople = new Map(); // regionKey -> [{ name, year }]

  for (const p of people) {
    const y = yearFromISO(p?.birth?.dateISO);
    const uniqueRegionsForPerson = new Set();
    const places = extractAllPlacesForPerson({ person: p, familiesById, personById });

    for (const pl of places) {
      const c = parsePlaceComponents(pl);
      const key = regionKeyFromComponents(c);
      uniqueRegionsForPerson.add(key);
      if (!regionStats.has(key)) regionStats.set(key, { count: 0, cities: new Map(), years: [] });
      const rs = regionStats.get(key);
      if (c.city) rs.cities.set(c.city, (rs.cities.get(c.city) || 0) + 1);
      if (y !== null) rs.years.push(y);
    }

    for (const key of uniqueRegionsForPerson) {
      const rs = regionStats.get(key);
      rs.count += 1;
      if (!regionPeople.has(key)) regionPeople.set(key, []);
      regionPeople.get(key).push({ id: p?.id, name: displayName(p), year: y });
    }
  }

  const qualifyingRegions = new Set(
    Array.from(regionStats.entries())
      .filter(([, v]) => (v?.count || 0) >= 3)
      .map(([k]) => k),
  );

  return { regionStats, regionPeople, qualifyingRegions };
}

async function generateBook() {
  const args = parseArgs(process.argv.slice(2));
  if (args.clearCache) {
    fs.rmSync(path.join(projectRoot, "data", "narrative-cache"), { recursive: true, force: true });
  }

  const jsonPath = getLatestConvertedJsonPath();
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const individuals = Array.isArray(data.individuals) ? data.individuals : [];
  const families = Array.isArray(data.families) ? data.families : [];
  const familiesById = new Map(families.filter((f) => f?.id).map((f) => [f.id, f]));

  const { generation, maxGen, personById } = buildGenerationMap({ individuals });
  const numberingRef = "book-bullets";

  if (args.person) {
    const { anchor, suggestions } = findAnchorPerson(individuals, args.person);
    if (!anchor) {
      console.log(`Person not found: '${args.person}'`);
      if (suggestions.length) {
        console.log("Did you mean:");
        for (const p of suggestions.slice(0, 5)) {
          console.log(`  ${p.id} — ${displayName(p)} (b.${yearFromISO(p?.birth?.dateISO) || "unknown"})`);
        }
      }
      console.log("Use --person '@ID@' for exact match");
      return;
    }

    const ancestorsMap = getAncestors(anchor.id, individuals, families, args.ancestors);
    const descendantsMap = getDescendants(anchor.id, individuals, families, args.descendants, { includeSpouses: args.includeSpouses });
    const ancestorIds = Array.from(ancestorsMap.entries()).filter(([, l]) => l < 0).map(([id]) => id);
    const descendantIds = Array.from(descendantsMap.keys());
    const includedIds = new Set([anchor.id, ...ancestorIds, ...descendantIds]);
    const includedPeople = Array.from(includedIds).map((id) => personById.get(id)).filter(Boolean);
    const livingDescendants = descendantIds.map((id) => personById.get(id)).filter((p) => p?.living === true);

    const anchorName = displayName(anchor);
    const anchorFirst = firstName(anchor).toLowerCase() || "person";
    const anchorSurname = (normalizeSurname(anchor?.name?.surname) || "family").toLowerCase();
    const dateStr = format(new Date(), "yyyy-MM-dd");
    const outDir = path.join(projectRoot, "reports");
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `family-book-${anchorFirst}-${anchorSurname}-${dateStr}.docx`);

    const by = includedPeople.map((p) => yearFromISO(p?.birth?.dateISO)).filter((y) => y !== null);
    const dy = includedPeople
      .map((p) => yearFromISO(p?.death?.dateISO))
      .filter((y) => y !== null);
    const minYear = by.length ? Math.min(...by) : null;
    const maxYear = dy.length ? Math.max(...dy) : by.length ? Math.max(...by) : null;

    console.log(`Person-anchored book: ${anchorName} (${anchor.id})`);
    console.log(`Ancestors: ${args.ancestors} levels (${ancestorIds.length} individuals)`);
    console.log(`Descendants: ${args.descendants} levels (${descendantIds.length} individuals)`);
    console.log(`Living descendants: ${livingDescendants.length} (names only)`);
    console.log(`Total included: ${includedPeople.length} individuals`);
    console.log(`Generating: ${path.basename(outPath)}`);

    const children = [];
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 800, after: 120 },
        children: [new TextRun({ text: `The Family of ${anchorName}`, font: "Arial", size: 54, bold: true, color: "1F3864" })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: `${args.ancestors} Generations Back · ${args.descendants} Generations Forward`, font: "Arial", size: 28 })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: `${minYear || "?"} — ${maxYear || "?"}`, font: "Arial", size: 24, color: "666666" })],
      }),
    );

    if (!args.noImages) {
      let coverImageParagraph = null;
      const localCover = await findLocalPortrait(anchor);
      if (localCover) {
        coverImageParagraph = await buildImageParagraph(localCover);
      } else if (anchor?.birth?.place) {
        const coverImg = await getCachedOrFetchCommonsImage(anchor.birth.place, { birthYear: yearFromISO(anchor?.birth?.dateISO) });
        if (coverImg?.buffer) {
          const cachePath = path.join(projectRoot, "data", "image-cache", `${String(anchor.id || "anchor").replace(/[^A-Za-z0-9_-]/g, "_")}.${coverImg.ext || "jpg"}`);
          fs.writeFileSync(cachePath, coverImg.buffer);
          coverImageParagraph = await buildImageParagraph(cachePath, coverImg.ext);
        }
      }
      if (coverImageParagraph) {
        children.push(coverImageParagraph);
      } else {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: "[No historical image available for this location]", italics: true, color: "999999", size: 18, font: "Arial" })],
          }),
        );
      }
    }

    children.push(
      new Paragraph({ pageBreakBefore: true }),
    );

    const ancestorLevels = Array.from(new Set(Array.from(ancestorsMap.values()).filter((l) => l < 0).map((l) => Math.abs(l)))).sort((a, b) => b - a);
    for (const level of ancestorLevels) {
      const people = Array.from(ancestorsMap.entries())
        .filter(([, l]) => Math.abs(l) === level)
        .map(([id]) => personById.get(id))
        .filter((p) => p && p?.living !== true)
        .sort((a, b) => (yearFromISO(a?.birth?.dateISO) || 9999) - (yearFromISO(b?.birth?.dateISO) || 9999));
      children.push(heading(ancestorLevelLabel(level), 1), body(`Included ancestors at this level: ${people.length}`));
      for (const person of people) {
        const relation = relationshipSubtitle({ person, personById, familiesById });
        const lifeStageContext = await getLifeStageContext(person);
        const { text: narrative } = await getNarrative(person, { lifeStageContext, familiesById, personById }, { refresh: args.refresh, noAi: args.noAi });
        let imgParagraph = null;
        let imgCaption = null;
        if (!args.noImages) {
          const q = person?.birth?.place || "";
          if (q) {
            const result = await getCachedOrFetchCommonsImage(q, { birthYear: yearFromISO(person?.birth?.dateISO) });
            if (result?.buffer) {
              const cachePath = path.join(projectRoot, "data", "image-cache", `${String(person.id || "person").replace(/[^A-Za-z0-9_-]/g, "_")}.${result.ext || "jpg"}`);
              fs.writeFileSync(cachePath, result.buffer);
              imgParagraph = await buildImageParagraph(cachePath, result.ext);
              if (imgParagraph) imgCaption = captionText(`${result.title || "Image"} — ${result.license || "unknown"}`);
            }
          }
        }
        children.push(
          heading(displayName(person), 2),
          ...(relation ? [body(relation)] : []),
          ...(imgParagraph ? [imgParagraph, imgCaption] : [new Paragraph({ children: [new TextRun({ text: "[No historical image available for this location]", italics: true, color: "999999", size: 18, font: "Arial" })] })]),
          body(narrative),
          divider(),
        );
      }
      children.push(new Paragraph({ pageBreakBefore: true }));
    }

    // Anchor chapter
    const anchorContext = await getLifeStageContext(anchor);
    const { text: anchorNarrative } = await getNarrative(
      anchor,
      { lifeStageContext: anchorContext, familiesById, personById },
      { refresh: args.refresh, noAi: args.noAi, maxWords: 200 },
    );
    children.push(heading(`The Life of ${anchorName}`, 1), body(anchorNarrative));

    const timelineRows = [];
    const seenTimeline = new Set();
    const addTimeline = (year, age, event, eventType = "Event") => {
      if (!Number.isFinite(year)) return;
      const key = `${year}|${String(eventType || "").toUpperCase()}`;
      if (seenTimeline.has(key)) return;
      seenTimeline.add(key);
      timelineRows.push([String(year), age !== null ? String(age) : "—", event]);
    };
    const anchorBirthYear = yearFromISO(anchor?.birth?.dateISO);
    addTimeline(anchorBirthYear, 0, `Born${anchor?.birth?.place ? ` in ${anchor.birth.place}` : ""}`, "BIRT");
    for (const fid of anchor?.familiesAsSpouse || []) {
      const fam = familiesById.get(fid);
      if (!fam) continue;
      const my = yearFromISO(fam?.marriage?.dateISO);
      addTimeline(my, anchorBirthYear !== null && my !== null ? my - anchorBirthYear : null, `Married${fam?.marriage?.place ? ` in ${fam.marriage.place}` : ""}`, "MARR");
      for (const cid of fam?.children || []) {
        const child = personById.get(cid);
        const cy = yearFromISO(child?.birth?.dateISO);
        addTimeline(cy, anchorBirthYear !== null && cy !== null ? cy - anchorBirthYear : null, `Child born: ${displayName(child)}`, `CHIL-${cid}`);
      }
    }
    for (const e of anchor?.events || []) {
      const ey = yearFromISO(e?.dateISO);
      const eType = String(e?.type || "Event").toUpperCase();
      addTimeline(ey, anchorBirthYear !== null && ey !== null ? ey - anchorBirthYear : null, `${e?.type || "Event"}${e?.place ? `, ${e.place}` : ""}`, eType);
    }
    const anchorDeathYear = yearFromISO(anchor?.death?.dateISO);
    addTimeline(anchorDeathYear, anchorBirthYear !== null && anchorDeathYear !== null ? anchorDeathYear - anchorBirthYear : null, `Passed away${anchor?.death?.place ? ` in ${anchor.death.place}` : ""}`, "DEAT");
    timelineRows.sort((a, b) => Number(a[0]) - Number(b[0]));
    if (timelineRows.length) {
      children.push(
        heading("Life Timeline", 2),
        new Table({
          columnWidths: [1200, 1200, 6960],
          width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
          rows: [
            new TableRow({
              children: ["Year", "Age", "Event"].map((t) => new TableCell({
                width: { size: t === "Event" ? 6960 : 1200, type: WidthType.DXA },
                shading: { type: ShadingType.CLEAR, fill: "1F3864" },
                margins: { top: 80, bottom: 80, left: 120, right: 120 },
                children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, color: "FFFFFF" })] })],
              })),
            }),
            ...timelineRows.map((r, idx) => new TableRow({
              children: r.map((t, i) => new TableCell({
                width: { size: i === 2 ? 6960 : 1200, type: WidthType.DXA },
                shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? "FFFFFF" : "F2F2F2" },
                margins: { top: 80, bottom: 80, left: 120, right: 120 },
                children: [new Paragraph({ children: [new TextRun({ text: String(t), font: "Arial", size: 22 })] })],
              })),
            })),
          ],
        }),
        new Paragraph({ pageBreakBefore: true }),
      );
    }

    const descendantLevels = Array.from(new Set(Array.from(descendantsMap.values()))).sort((a, b) => a - b);
    for (const level of descendantLevels) {
      const allLevel = Array.from(descendantsMap.entries())
        .filter(([, l]) => l === level)
        .map(([id]) => personById.get(id))
        .filter(Boolean)
        .sort((a, b) => (yearFromISO(a?.birth?.dateISO) || 9999) - (yearFromISO(b?.birth?.dateISO) || 9999));
      const deceasedLevel = allLevel.filter((p) => p?.living !== true);
      const livingLevel = allLevel.filter((p) => p?.living === true);
      children.push(heading(descendantLevelLabel(level), 1), body(`Included descendants at this level: ${allLevel.length}`));
      for (const person of deceasedLevel) {
        const relation = relationshipSubtitle({ person, personById, familiesById });
        const lifeStageContext = await getLifeStageContext(person);
        const { text: narrative } = await getNarrative(person, { lifeStageContext, familiesById, personById }, { refresh: args.refresh, noAi: args.noAi });
        let imgParagraph = null;
        let imgCaption = null;
        if (!args.noImages) {
          const q = person?.birth?.place || "";
          if (q) {
            const result = await getCachedOrFetchCommonsImage(q, { birthYear: yearFromISO(person?.birth?.dateISO) });
            if (result?.buffer) {
              const cachePath = path.join(projectRoot, "data", "image-cache", `${String(person.id || "person").replace(/[^A-Za-z0-9_-]/g, "_")}.${result.ext || "jpg"}`);
              fs.writeFileSync(cachePath, result.buffer);
              imgParagraph = await buildImageParagraph(cachePath, result.ext);
              if (imgParagraph) imgCaption = captionText(`${result.title || "Image"} — ${result.license || "unknown"}`);
            }
          }
        }
        children.push(
          heading(displayName(person), 2),
          ...(relation ? [body(relation)] : []),
          ...(imgParagraph ? [imgParagraph, imgCaption] : [new Paragraph({ children: [new TextRun({ text: "[No historical image available for this location]", italics: true, color: "999999", size: 18, font: "Arial" })] })]),
          body(narrative),
          divider(),
        );
      }
      if (livingLevel.length) {
        children.push(
          heading("Living Family Members (names only)", 2),
          ...bulletList(livingLevel.map((p) => `${firstName(p)} ${cleanName(p?.name?.surname || "")} — Living`), numberingRef),
        );
      }
      children.push(new Paragraph({ pageBreakBefore: true }));
    }

    // Back matter
    const asciiLines = buildAsciiTree({ anchor, ancestorsMap, descendantsMap, personById });
    children.push(
      heading("ASCII Family Tree", 1),
      new Table({
        columnWidths: [9360],
        width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
        rows: [
          new TableRow({
            children: [
              new TableCell({
                width: { size: 9360, type: WidthType.DXA },
                shading: { type: ShadingType.CLEAR, fill: "F5F5F5" },
                margins: { top: 80, bottom: 80, left: 120, right: 120 },
                children: asciiLines.map(
                  (line) =>
                    new Paragraph({
                      spacing: { after: 40 },
                      children: [new TextRun({ text: line, font: "Courier New", size: 18 })],
                    }),
                ),
              }),
            ],
          }),
        ],
      }),
      new Paragraph({ pageBreakBefore: true }),
      heading("Index", 1),
      ...bulletList(
        includedPeople
          .slice()
          .sort((a, b) => normalizeSurname(a?.name?.surname).localeCompare(normalizeSurname(b?.name?.surname)) || displayName(a).localeCompare(displayName(b)))
          .map((p) => `${displayName(p)} (${yearFromISO(p?.birth?.dateISO) || "—"})`),
        numberingRef,
      ),
    );

    const doc = new Document({
      styles: {
        default: {
          document: {
            run: { font: "Arial", size: 22 },
            paragraph: { spacing: { line: 312 } },
          },
        },
      },
      numbering: {
        config: [
          {
            reference: numberingRef,
            levels: [{ level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 260 } } } }],
          },
        ],
      },
      sections: [
        {
          properties: { page: { size: { width: PAGE_WIDTH_DXA, height: PAGE_HEIGHT_DXA }, margin: { top: MARGIN_DXA, bottom: MARGIN_DXA, left: MARGIN_DXA, right: MARGIN_DXA } } },
          footers: { default: buildFooter({ surname: normalizeSurname(anchor?.name?.surname) || "Family" }) },
          children,
        },
      ],
    });
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(outPath, buffer);
    console.log(`Family book generated: reports/${path.basename(outPath)}`);
    return;
  }

  const deceasedAll = individuals.filter((p) => !isLiving(p));
  const livingFlaggedAll = individuals.filter((p) => p?.living === true);
  const surnameSet = (() => {
    const s = new Set();
    if (args.surnames) {
      const parts = String(args.surnames)
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      for (const p of parts) s.add(normalizeSurname(p));
    }
    if (args.surname) s.add(normalizeSurname(args.surname));
    return s;
  })();
  const hasSurnameFilter = surnameSet.size > 0;
  const deceased = hasSurnameFilter
    ? deceasedAll.filter((p) => surnameSet.has(normalizeSurname(p?.name?.surname)))
    : deceasedAll;
  const livingInScope = (() => {
    const base = hasSurnameFilter ? livingFlaggedAll.filter((p) => surnameSet.has(normalizeSurname(p?.name?.surname))) : livingFlaggedAll;
    const includeGen = Number.isFinite(args.generation) ? args.generation : null;
    if (!includeGen) return base;
    return base.filter((p) => generation.get(p?.id) === includeGen);
  })();
  if (livingInScope.length) {
    console.log(`Skipping ${livingInScope.length} living individuals (privacy protection)`);
  }

  const surnameCounts = new Map();
  for (const p of deceased) {
    const s = normalizeSurname(p?.name?.surname);
    if (!s) continue;
    surnameCounts.set(s, (surnameCounts.get(s) || 0) + 1);
  }
  const topSurnames = Array.from(surnameCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s]) => s);
  const mostCommonSurname = topSurnames[0] || "Family";
  const secondSurname = topSurnames[1] || "";

  const birthYears = deceased.map((p) => yearFromISO(p?.birth?.dateISO)).filter((y) => y !== null);
  const earliestYear = birthYears.length ? Math.min(...birthYears) : null;
  const latestYear = birthYears.length ? Math.max(...birthYears) : null;

  const dateStr = format(new Date(), "yyyy-MM-dd");
  const generatedDate = format(new Date(), "MMMM d, yyyy");

  const outDir = path.join(projectRoot, "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const filterSlugParts = [];
  if (hasSurnameFilter) {
    const ordered = args.surnames
      ? String(args.surnames).split(",").map((s) => s.trim()).filter(Boolean)
      : args.surname
        ? [String(args.surname)]
        : [];
    for (const s of ordered) filterSlugParts.push(slugifySurname(s));
  }
  const includeGen = Number.isFinite(args.generation) ? args.generation : null;
  if (includeGen) filterSlugParts.push(`gen${includeGen}`);
  const filterSlug = filterSlugParts.length ? `-${filterSlugParts.join("-")}` : "";
  const outPath = path.join(outDir, `family-book${filterSlug}-${dateStr}.docx`);

  // Selection defaults + page estimate
  const includeSurname = args.surname ? normalizeSurname(args.surname) : null;
  const includeSurnames = hasSurnameFilter ? surnameSet : null;

  const genBuckets = new Map();
  for (const p of deceased) {
    const g = generation.get(p.id) || null;
    if (!g) continue;
    if (includeGen && g !== includeGen) continue;
    if (includeSurnames && !includeSurnames.has(normalizeSurname(p?.name?.surname))) continue;
    if (!genBuckets.has(g)) genBuckets.set(g, []);
    genBuckets.get(g).push(p);
  }

  const genNumbers = Array.from(genBuckets.keys()).sort((a, b) => a - b);

  // Place blocks + homelands (optional)
  const shownRegions = new Set();
  const placeReferenceByRegion = new Map(); // regionKey -> generation number of first Place in Time block
  const homelandReferenceByRegion = new Map();
  const homelands = args.noPlaces ? [] : detectFamilyHomelands(deceased, families);
  const homelandsByGeneration = new Map();
  for (const h of homelands) {
    const g = h.earliestGeneration;
    if (!homelandsByGeneration.has(g)) homelandsByGeneration.set(g, []);
    homelandsByGeneration.get(g).push(h);
    homelandReferenceByRegion.set(h.regionKey, g);
  }

  // Categorize by completeness
  let fullCount = 0;
  let briefCount = 0;
  let rosterCount = 0;
  const featuredByGen = new Map();
  for (const g of genNumbers) {
    const people = genBuckets.get(g).slice().sort((a, b) => completenessScore(b) - completenessScore(a));
    const full = [];
    const brief = [];
    const roster = [];
    for (const p of people) {
      const s = completenessScore(p);
      if (s >= 60) full.push(p);
      else if (s >= 40) brief.push(p);
      else roster.push(p);
    }
    featuredByGen.set(g, { full, brief, roster });
    fullCount += full.length;
    briefCount += brief.length;
    rosterCount += roster.length;
  }

  // Rough page estimate and cap to 500 pages
  const estimatedPages = 6 + fullCount * 2 + briefCount * 1 + Math.ceil(rosterCount / 40) + genNumbers.length * 2;
  const pageCap = 500;
  let capMessage = null;
  if (!includeGen && !hasSurnameFilter && estimatedPages > pageCap) {
    capMessage = `Estimated pages (~${estimatedPages}) exceeds cap (${pageCap}). Consider using --generation or --surname.`;
  }

  const imageCredits = [];
  let localImages = 0;
  let wikimediaImages = 0;
  let aiNarratives = 0;
  let templateNarratives = 0;

  const children = [];

  // Cover page
  const filteredSurnameList = (() => {
    if (!hasSurnameFilter) return [];
    const ordered = args.surnames
      ? String(args.surnames).split(",").map((s) => s.trim()).filter(Boolean)
      : args.surname
        ? [String(args.surname)]
        : [];
    return ordered.map((s) => normalizeSurname(s)).filter(Boolean);
  })();

  const displaySurname = (s) => {
    const raw = String(s || "").toLowerCase();
    return raw ? raw.slice(0, 1).toUpperCase() + raw.slice(1) : "";
  };

  const coverTitle = (() => {
    if (hasSurnameFilter) {
      if (filteredSurnameList.length === 1) return `The ${displaySurname(filteredSurnameList[0])} Family`;
      const a = displaySurname(filteredSurnameList[0] || mostCommonSurname);
      const b = displaySurname(filteredSurnameList[1] || secondSurname || "");
      return b ? `${a} & ${b} Families` : `${a} Families`;
    }
    return `${displaySurname(mostCommonSurname)} Family History`;
  })();

  children.push(
    shadedBlock({ text: "", fill: "FAF6F0" }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      shading: { type: ShadingType.CLEAR, fill: "FAF6F0" },
      spacing: { before: 800, after: 200 },
      children: [
        new TextRun({
          text: coverTitle,
          font: "Arial",
          size: 54,
          bold: true,
          color: "1F3864",
        }),
      ],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      shading: { type: ShadingType.CLEAR, fill: "FAF6F0" },
      children: [
        new TextRun({
          text: `A Family History — ${earliestYear ?? "?"} to ${latestYear ?? "?"}`,
          font: "Arial",
          size: 28,
          bold: true,
        }),
      ],
      spacing: { after: 300 },
    }),
  );

  // Cover portrait (earliest known ancestor)
  const earliestPerson = earliestYear === null
    ? null
    : deceased
        .filter((p) => yearFromISO(p?.birth?.dateISO) === earliestYear)
        .sort((a, b) => displayName(a).localeCompare(displayName(b)))[0];

  if (!args.noImages && earliestPerson) {
    const portraitPath = await findLocalPortrait(earliestPerson);
    if (portraitPath) {
      const run = await imageRunFromFile(portraitPath);
      localImages++;
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          shading: { type: ShadingType.CLEAR, fill: "FAF6F0" },
          children: [run],
          spacing: { after: 120 },
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          shading: { type: ShadingType.CLEAR, fill: "FAF6F0" },
          children: [new TextRun({ text: cleanName(displayName(earliestPerson)), font: "Arial", size: 18, italics: true, color: "666666" })],
        }),
      );
    } else {
      children.push(placeholderBox("Portrait placeholder"));
    }
  } else {
    children.push(placeholderBox("Portrait placeholder"));
  }

  children.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      shading: { type: ShadingType.CLEAR, fill: "FAF6F0" },
      spacing: { before: 300, after: 600 },
      children: [
        new TextRun({
          text: `Compiled ${generatedDate} · ${individuals.length.toLocaleString()} individuals across ${maxGen} generations`,
          font: "Arial",
          size: 22,
        }),
      ],
    }),
    new Paragraph({ pageBreakBefore: true }),
  );

  // About this book
  children.push(
    heading("About This Book", 1),
    body(
      "This book is a living story of a family over time — a collection of names, places, and moments that shaped real lives. It is built from a GEDCOM family tree, then gently turned into a readable narrative meant to be shared across generations.",
    ),
    body(
      "Some pages are richly detailed, while others are brief — not because those people mattered less, but because the record is still incomplete. If you spot a missing detail, you can help the story grow by adding sources, places, and dates.",
    ),
    divider(),
    new Paragraph({ pageBreakBefore: true }),
  );

  // TOC
  children.push(
    heading("Table of Contents", 1),
    new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }),
    new Paragraph({ pageBreakBefore: true }),
  );

  // Chapters
  for (const g of genNumbers) {
    const bucket = featuredByGen.get(g);
    const allInGen = genBuckets.get(g) || [];
    let skippedLiving = 0;
    const usedSidebars = new Set();
    console.log(`Generating Generation ${g} (${allInGen.length} individuals)...`);
    const years = allInGen.map((p) => yearFromISO(p?.birth?.dateISO)).filter((y) => y !== null);
    const minY = years.length ? Math.min(...years) : null;
    const maxY = years.length ? Math.max(...years) : null;
    const decadeRange = generationRangeLabel(g);
    const commonRegion = pickMostCommon(allInGen.map((p) => stateFromPlace(p?.birth?.place || "")));

    // Family Homeland block(s) at start of earliest generation where detected
    if (!args.noPlaces && homelandsByGeneration.has(g)) {
      const homelandBlocks = homelandsByGeneration.get(g);
      for (const homeland of homelandBlocks) {
        const regionKey = homeland.regionKey;
        if (shownRegions.has(`HOMELAND:${regionKey}`)) continue;
        shownRegions.add(`HOMELAND:${regionKey}`);
        // Treat a Homeland as having "covered" the region so later chapters use cross-references.
        shownRegions.add(regionKey);

        const regionPeople = deceased.filter((p) => {
          const comps = parsePlaceComponents(p?.birth?.place || "");
          return regionKeyFromComponents(comps) === regionKey;
        });

        const surnameCounts = new Map();
        for (const p of regionPeople) {
          const s = normalizeSurname(p?.name?.surname);
          if (!s) continue;
          surnameCounts.set(s, (surnameCounts.get(s) || 0) + 1);
        }
        const topSurname = Array.from(surnameCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "Family";

        const years = regionPeople.map((p) => yearFromISO(p?.birth?.dateISO)).filter((y) => y !== null);
        const earliest = years.length ? Math.min(...years) : null;
        const latest = years.length ? Math.max(...years) : null;
        const spanGens = homeland.generations.length;

        const regionName = regionDisplayName(regionKey, "");
        const decade = earliest !== null ? `${decadeFromYear(earliest)}s` : null;

        // Image + summary (cached)
        let placeImage = null;
        let summary = null;
        if (!args.noImages) {
          try {
            const regionBirthYear = earliest !== null ? earliest : null;
            placeImage = await getPlaceImage(regionName, regionBirthYear);
          } catch {
            placeImage = null;
          }
        }
        try {
          summary = await getPlaceSummary(regionName, decade);
        } catch {
          summary = null;
        }

        const relevantContext = [];
        if (earliest !== null) {
          const scope = regionKey.startsWith("USA|") ? (regionKey.split("|")[1] || "USA") : (regionKey.split("|")[1] || "global");
          const layer = regionKey.startsWith("USA|") ? "region" : "country";
          const c1 = await getContext(earliest, layer, scope, topSurname);
          const c2 = await getContext(earliest + 20, layer, scope, topSurname);
          const c3 = await getContext((latest ?? earliest) - 10, "world", "global", topSurname);
          for (const c of [c1, c2, c3]) {
            const t = String(c || "").trim();
            if (t) relevantContext.push(t);
          }
        }

        children.push(
          heading(`The ${topSurname} Homeland: ${regionName}`, 1),
          divider(),
        );

        if (placeImage?.cachePath) {
          try {
            const run = await imageRunFromFile(placeImage.cachePath, placeImage.ext);
            wikimediaImages++;
            children.push(
              new Paragraph({ alignment: AlignmentType.CENTER, children: [run], spacing: { after: 80 } }),
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: placeImage.caption || `${regionName}`, font: "Arial", size: 18, italics: true, color: "666666" }),
                ],
              }),
            );
          } catch {
            children.push(placeholderBox(regionName));
          }
        } else {
          children.push(placeholderBox(regionName));
        }

        const rootsText = `The ${topSurname} family maintained deep roots in ${regionName} for ${spanGens} generations${
          earliest !== null && latest !== null ? `, from ${earliest} to ${latest}` : ""
        }.`;
        const contextText = summary ? ` ${summary}` : "";
        children.push(
          heading(`Roots in ${regionName}`, 2),
          body(`${rootsText}${contextText}`),
          heading("What Life Was Like", 2),
          ...bulletList(
            relevantContext.length ? relevantContext : ["No matching historical context found for this region yet."],
            numberingRef,
          ),
        );

        // Migration away (simple: compare this gen’s top region to later gens for the same surname)
        const individualsByGeneration = new Map();
        for (const gg of genNumbers) {
          individualsByGeneration.set(gg, genBuckets.get(gg) || []);
        }
        // (Optional) a simple narrative if the next generation’s top region differs
        const thisGenRegion = regionName;
        const laterGen = genNumbers.find((gg) => gg > g);
        if (laterGen) {
          const laterPeople = (genBuckets.get(laterGen) || []).filter((p) => normalizeSurname(p?.name?.surname) === topSurname);
          const laterRegionCounts = new Map();
          for (const p of laterPeople) {
            const key = regionKeyFromComponents(parsePlaceComponents(p?.birth?.place || ""));
            laterRegionCounts.set(key, (laterRegionCounts.get(key) || 0) + 1);
          }
          const laterTop = Array.from(laterRegionCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
          if (laterTop && laterTop !== regionKey) {
            children.push(
              heading("The Journey Away", 2),
              body(
                `By Generation ${laterGen}, the ${topSurname} family begins to appear in records in ${regionDisplayName(laterTop, "")}, suggesting a migration sometime after ${decade || "this period"}.`,
              ),
            );
          }
        }

        // Members table (compact)
        const memberRows = regionPeople
          .slice(0, 60)
          .map((p) => [displayName(p), String(yearFromISO(p?.birth?.dateISO) ?? "—"), String(yearFromISO(p?.death?.dateISO) ?? "—"), ""]);
        children.push(
          heading(`Family Members from This Region`, 2),
          new Table({
            columnWidths: [2340, 2340, 2340, 2340],
            width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
            rows: [
              new TableRow({
                children: ["Name", "Born", "Died", "Notes"].map(
                  (t) =>
                    new TableCell({
                      width: { size: 2340, type: WidthType.DXA },
                      shading: { type: ShadingType.CLEAR, fill: "1F3864" },
                      margins: { top: 80, bottom: 80, left: 120, right: 120 },
                      children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, color: "FFFFFF" })] })],
                    }),
                ),
              }),
              ...memberRows.map(
                (r, idx) =>
                  new TableRow({
                    children: r.map(
                      (t) =>
                        new TableCell({
                          width: { size: 2340, type: WidthType.DXA },
                          shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? "FFFFFF" : "F2F2F2" },
                          margins: { top: 80, bottom: 80, left: 120, right: 120 },
                          children: [new Paragraph({ children: [new TextRun({ text: String(t), font: "Arial", size: 22 })] })],
                        }),
                    ),
                  }),
              ),
            ],
          }),
          new Paragraph({ pageBreakBefore: true }),
        );
      }
    }

    // Chapter title page
    const chapterQuote = (() => {
      const medianYear = medianBirthYearForPeople(allInGen);
      if (medianYear === null) return Promise.resolve("Did you know? Families often moved because of jobs, land, or safety.");
      return getContext(medianYear, "world", "global", `gen-${g}`);
    })();
    const chapterQuoteText =
      (await chapterQuote) || "Did you know? Every generation lived through new inventions and new challenges.";

    children.push(
      new Paragraph({
        shading: { type: ShadingType.CLEAR, fill: "1F3864" },
        spacing: { before: 120, after: 120 },
        children: [
          new TextRun({
            text: `Generation ${g} — ${decadeRange}`,
            font: "Arial",
            size: 44,
            bold: true,
            color: "FFFFFF",
          }),
        ],
      }),
      body(`Individuals in this generation: ${allInGen.length}`),
      body(`Most common birthplace/region: ${commonRegion || "—"}`),
      shadedBlock({ text: `“${chapterQuoteText}”`, fill: "FFF9C4", borderColor: "F0C040" }),
      new Paragraph({ pageBreakBefore: true }),
    );

    // Era introduction block
    const eraContext = (() => {
      const medianYear = medianBirthYearForPeople(allInGen);
      if (medianYear === null) return Promise.resolve("");
      return getContext(medianYear, "world", "global", `gen-era-${g}`);
    })();
    const eraContextText = await eraContext;
    if (eraContextText) {
      children.push(
        heading("Era Introduction", 2),
        body(`${eraContextText}`),
        divider(),
      );
    }

    // Full spreads (two-column section simulated by short table with 2 cells)
    const sidebarYearsForGen = minY !== null ? [minY, minY + 10, minY + 20, maxY ?? minY] : [];
    let sidebarCounter = 0;
    const referencedRegionsThisGen = new Set();
    const genPlaceIndex = args.noPlaces ? null : buildGenerationPlaceIndex({ people: allInGen, familiesById, personById });
    const fullPeople = bucket.full.filter((p) => !includeSurnames || includeSurnames.has(normalizeSurname(p?.name?.surname)));
    let processedFull = 0;

    for (const person of fullPeople) {
      if (person?.living === true) {
        skippedLiving++;
        continue;
      }
      const personSurname = normalizeSurname(person?.name?.surname);
      if (processedFull > 0 && processedFull % 25 === 0) {
        console.log(`  → ${processedFull}/${fullPeople.length} individuals | Gen ${g} | ${personSurname || "UNKNOWN"}`);
      }

      const lifeStageContext = await getLifeStageContext(person);
      const lifeTimesEvents = lifeStageBulletsFromContext(lifeStageContext);
      const { text: narrative, source } = await getNarrative(
        person,
        { lifeStageContext, familiesById, personById },
        { refresh: args.refresh, noAi: args.noAi },
      );
      if (source === "ollama") aiNarratives++;
      else templateNarratives++;

      const born = person?.birth?.date ? `Born ${person.birth.date}` : "Born (date unknown)";
      const bornPlace = person?.birth?.place ? ` · ${person.birth.place}` : "";
      const died = person?.death?.date ? `Died ${person.death.date}` : "";
      const diedPlace = person?.death?.place ? ` · ${person.death.place}` : "";
      const lifeLine = `${born}${bornPlace}${died ? `  |  ${died}${diedPlace}` : ""}`;

      // Image selection
      let imageRun = null;
      let caption = null;
      if (!args.noImages) {
        const local = await findLocalPortrait(person);
        if (local) {
          imageRun = await imageRunFromFile(local);
          localImages++;
          caption = "Family photo (local media)";
        } else {
          const query = person?.birth?.place || person?.marriage?.place || "";
          if (query) {
            try {
              const img = await getCachedOrFetchCommonsImage(query, {
                birthYear: yearFromISO(person?.birth?.dateISO),
              });
              if (img?.cachePath) {
                imageRun = await imageRunFromFile(img.cachePath, img.ext);
                wikimediaImages++;
                caption = `Historic view: ${query}`;
                if (img.metadata) imageCredits.push(img.metadata);
              }
            } catch {
              // ignore
            }
          }
        }
      }

      const leftChildren = [];
      const relationLine = relationshipSubtitle({ person, personById, familiesById });
      leftChildren.push(
        new Paragraph({
          children: [new TextRun({ text: displayName(person), font: "Arial", size: 36, bold: true })],
        }),
        ...(relationLine
          ? [
              new Paragraph({
                children: [new TextRun({ text: relationLine, font: "Arial", size: 20, italics: true, color: "666666" })],
              }),
            ]
          : []),
        new Paragraph({ children: [new TextRun({ text: lifeLine, font: "Arial", size: 22, color: "666666" })] }),
        divider(),
      );

      if (imageRun) {
        leftChildren.push(
          new Paragraph({ alignment: AlignmentType.CENTER, children: [imageRun], spacing: { after: 80 } }),
          captionText(caption || ""),
        );
      } else {
        leftChildren.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: "[No historical image available for this location]", italics: true, color: "999999", size: 18, font: "Arial" })],
          }),
        );
      }

      const rightChildren = [];
      rightChildren.push(
        sectionLabel(`About ${firstName(person)}`),
        body(narrative),
        divider(),
        sectionLabel("Life & Times"),
      );
      const bullets = lifeTimesEvents.slice(0, 5);
      rightChildren.push(...bulletList(bullets.length ? bullets : ["No era facts available yet."], numberingRef));

      rightChildren.push(
        divider(),
        sectionLabel("Family connections"),
        personConnectionsBox({ person, personById, familiesById }),
        new Paragraph({
          children: [
            new TextRun({
              text: `Documented by ${Array.isArray(person?.birth?.sourceRefs) ? person.birth.sourceRefs.length : 0} birth sources`,
              font: "Arial",
              size: 20,
              color: "666666",
            }),
          ],
        }),
      );

      const spread = new Table({
        columnWidths: [3200, 6160],
        width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
        rows: [
            new TableRow({
              children: [
                new TableCell({
                  width: { size: 3200, type: WidthType.DXA },
                  margins: { top: 80, bottom: 80, left: 120, right: 120 },
                  children: leftChildren,
                }),
                new TableCell({
                  width: { size: 6160, type: WidthType.DXA },
                  margins: { top: 80, bottom: 80, left: 120, right: 120 },
                  children: rightChildren,
                }),
              ],
            }),
          ],
      });

      children.push(spread);

      // Place in Time blocks (insert between spreads)
      if (!args.noPlaces) {
        const allPlaces = extractAllPlacesForPerson({ person, familiesById, personById });
        const primaryPlace = allPlaces[0] || person?.birth?.place || "";
        const comps = parsePlaceComponents(primaryPlace);
        const regionKey = regionKeyFromComponents(comps);

        const qualifies = genPlaceIndex?.qualifyingRegions?.has(regionKey) || false;
        const alreadyShown = shownRegions.has(regionKey);
        const homelandGen = homelandReferenceByRegion.get(regionKey);
        const placeFirstGen = placeReferenceByRegion.get(regionKey);

        if (qualifies && (!alreadyShown || !referencedRegionsThisGen.has(regionKey))) {
          referencedRegionsThisGen.add(regionKey);

          // If we already covered this region elsewhere in the book, insert a compact cross-reference.
          if (alreadyShown) {
            const refGen = homelandGen && homelandGen < g ? homelandGen : placeFirstGen;
            if (refGen && refGen < g) {
              children.push(
                shadedBlock({
                  text: `📍 ${regionDisplayName(regionKey, comps.city || "")} — See the earlier feature in Generation ${refGen}.`,
                  fill: "E8F5E9",
                  borderColor: "388E3C",
                }),
              );
            }
            continue;
          }

          shownRegions.add(regionKey);
          placeReferenceByRegion.set(regionKey, g);

          // If this region has a Homeland feature, direct readers to it rather than repeating.
          if (homelandGen && homelandGen <= g) {
            children.push(
              shadedBlock({
                text: `📍 ${regionDisplayName(regionKey, comps.city || "")} — See the homeland feature in Generation ${homelandGen}.`,
                fill: "E8F5E9",
                borderColor: "388E3C",
              }),
            );
          } else {
            const stat = genPlaceIndex?.regionStats?.get(regionKey) || { cities: new Map(), years: [] };
            const cityHint = Array.from(stat.cities.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "";
            const placeName = regionDisplayName(regionKey, cityHint);
            const decade = stat.years.length ? `${decadeFromYear(Math.min(...stat.years))}s` : null;
            console.log(`  Place block: ${placeName}...`);

            let placeImage = null;
            if (!args.noImages) {
              try {
                const placeBirthYear = stat.years.length ? Math.min(...stat.years) : null;
                placeImage = await getPlaceImage(placeName, placeBirthYear);
              } catch {
                placeImage = null;
              }
            }
            let nowSummary = null;
            try {
              nowSummary = await getPlaceSummary(placeName, decade);
            } catch {
              nowSummary = null;
            }

            const who = (genPlaceIndex?.regionPeople?.get(regionKey) || [])
              .filter((entry) => {
                const person = personById.get(entry?.id);
                return !(person?.living === true);
              })
              .slice(0, 10)
              .map((p) => `${p.name}${p.year ? ` (b.${p.year})` : ""}`)
              .join(", ");

            const about = decade
              ? `In the ${decade}, records show multiple ancestors connected to ${placeName}. Communities like this were shaped by local work, travel routes, and the rhythms of seasons and markets.`
              : `Records show multiple ancestors connected to ${placeName}. Communities like this were shaped by local work, travel routes, and the rhythms of seasons and markets.`;

            children.push(
              shadedBlock({
                text: `📍 ${placeName}`,
                fill: "E8F5E9",
                borderColor: "388E3C",
              }),
              new Paragraph({
                children: [
                  new TextRun({ text: "ABOUT THIS PLACE", bold: true, font: "Arial", size: 24, smallCaps: true }),
                ],
                shading: { type: ShadingType.CLEAR, fill: "E8F5E9" },
              }),
              body(about),
            );

            if (placeImage?.cachePath) {
              try {
                const run = await imageRunFromFile(placeImage.cachePath, placeImage.ext);
                wikimediaImages++;
                children.push(
                  new Paragraph({ alignment: AlignmentType.CENTER, children: [run], spacing: { after: 80 } }),
                  new Paragraph({
                    alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: placeImage.caption || placeName, font: "Arial", size: 18, italics: true, color: "666666" })],
                  }),
                );
              } catch {
                // omit image if embedding fails
              }
            }

            children.push(
              new Paragraph({
                children: [new TextRun({ text: "WHO LIVED HERE", bold: true, font: "Arial", size: 24, smallCaps: true })],
                shading: { type: ShadingType.CLEAR, fill: "E8F5E9" },
              }),
              body(who || "—"),
            );

            if (nowSummary) {
              children.push(
                new Paragraph({
                  children: [new TextRun({ text: "THEN AND NOW", bold: true, font: "Arial", size: 24, smallCaps: true })],
                  shading: { type: ShadingType.CLEAR, fill: "E8F5E9" },
                }),
                body(`Today, ${nowSummary}`),
              );
            }
          }
        }
      }

      children.push(new Paragraph({ pageBreakBefore: true }));

      sidebarCounter++;
      processedFull++;
      if (sidebarCounter % 4 === 0 && sidebarYearsForGen.length) {
        const sidebarYear = sidebarYearsForGen[sidebarCounter % sidebarYearsForGen.length];
        const fact = await getUnusedSidebar(sidebarYear, usedSidebars, `gen-fact-${g}-${sidebarCounter}`);
        if (fact) {
          children.push(shadedBlock({ text: `Did you know? ${fact}`, fill: "FFF9C4", borderColor: "F0C040" }));
        }
      }

      // Rate limit AI calls
      await sleep(2000);
    }

    // Brief cards
    for (const person of bucket.brief) {
      if (person?.living === true) continue;
      const personSurname = normalizeSurname(person?.name?.surname);
      if (includeSurnames && !includeSurnames.has(personSurname)) continue;
      children.push(
        heading(`${displayName(person)} — In Brief`, 2),
        body(`Born: ${person?.birth?.date || "—"}${person?.birth?.place ? ` · ${person.birth.place}` : ""}`),
        body(`Died: ${person?.death?.date || "—"}${person?.death?.place ? ` · ${person.death.place}` : ""}`),
        divider(),
      );
    }

    // Roster table at end
    if (bucket.roster.length) {
      const rows = bucket.roster.slice(0, 200).map((p) => [
        p?.living === true ? null : displayName(p),
        p?.birth?.date ? String(yearFromISO(p.birth.dateISO) ?? "—") : "—",
        p?.death?.date ? String(yearFromISO(p.death.dateISO) ?? "—") : "—",
      ]).filter((r) => r[0] !== null);
      children.push(
        heading("Generation Roster (limited details)", 2),
        new Table({
          columnWidths: [3120, 3120, 3120],
          width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
          rows: [
            new TableRow({
              children: ["Name", "Born", "Died"].map(
                (t) =>
                  new TableCell({
                    width: { size: 3120, type: WidthType.DXA },
                    shading: { type: ShadingType.CLEAR, fill: "1F3864" },
                    margins: { top: 80, bottom: 80, left: 120, right: 120 },
                    children: [new Paragraph({ children: [new TextRun({ text: t, bold: true, color: "FFFFFF" })] })],
                  }),
              ),
            }),
            ...rows.map(
              (r, idx) =>
                new TableRow({
                  children: r.map(
                    (t) =>
                      new TableCell({
                        width: { size: 3120, type: WidthType.DXA },
                        shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? "FFFFFF" : "F2F2F2" },
                        margins: { top: 80, bottom: 80, left: 120, right: 120 },
                        children: [new Paragraph({ children: [new TextRun({ text: String(t), font: "Arial", size: 22 })] })],
                      }),
                  ),
                }),
            ),
          ],
        }),
      );
    }

    // Generation summary page
    const summaryPeople = allInGen.filter((p) => p?.living !== true);
    const topPlaces = summaryPeople
      .map((p) => stateFromPlace(p?.birth?.place || ""))
      .filter(Boolean);
    const top1 = pickMostCommon(topPlaces);
    const top2 = pickMostCommon(topPlaces.filter((x) => x !== top1));
    const top3 = pickMostCommon(topPlaces.filter((x) => x !== top1 && x !== top2));
    const familiesInGen = new Set();
    for (const p of summaryPeople) {
      for (const fid of Array.isArray(p?.familiesAsSpouse) ? p.familiesAsSpouse : []) familiesInGen.add(fid);
    }

    children.push(
      new Paragraph({ pageBreakBefore: true }),
      heading(`Generation ${g} Summary`, 1),
      table2Col([
        ["Individuals", String(summaryPeople.length)],
        ["Top places", [top1, top2, top3].filter(Boolean).join(", ") || "—"],
        ["Families represented", String(familiesInGen.size)],
        ["A simple note", "This generation connects family units that shaped the next chapter."],
      ]),
      new Paragraph({ pageBreakBefore: true }),
    );
    console.log(`Skipped ${skippedLiving} living individuals (privacy)`);
  }

  // Back matter — condensed stats
  const filterDescription = (() => {
    const parts = [];
    if (hasSurnameFilter) {
      const names = filteredSurnameList.map((s) => displaySurname(s)).filter(Boolean);
      if (names.length === 1) parts.push(`${names[0]} family`);
      else if (names.length >= 2) parts.push(`${names.slice(0, 2).join(" & ")} families`);
    }
    if (includeGen) parts.push(`Generation ${includeGen}`);
    return parts.length ? parts.join(", ") : null;
  })();

  const scopeIndividuals = (() => {
    // Stats should reflect what this run is showing.
    const ids = new Set();
    for (const g of genNumbers) {
      for (const p of genBuckets.get(g) || []) ids.add(p.id);
    }
    const deceasedShown = Array.from(ids).map((id) => personById.get(id)).filter(Boolean);
    const livingShown = livingInScope;
    return { deceasedShown, livingShown };
  })();

  const totalIndividuals = filterDescription ? scopeIndividuals.deceasedShown.length : individuals.filter((p) => p?.living !== true).length;
  const totalFamilies = filterDescription ? (() => {
    const famIds = new Set();
    for (const p of scopeIndividuals.deceasedShown) {
      for (const fid of Array.isArray(p?.familiesAsSpouse) ? p.familiesAsSpouse : []) famIds.add(fid);
      for (const fid of Array.isArray(p?.familiesAsChild) ? p.familiesAsChild : []) famIds.add(fid);
    }
    return famIds.size;
  })() : families.length;
  const livingCount = filterDescription ? scopeIndividuals.livingShown.length : individuals.filter(isLiving).length;
  const deceasedCount = totalIndividuals;
  const genRangeShown = filterDescription ? (genNumbers.length ? `${genNumbers[0]}–${genNumbers[genNumbers.length - 1]}` : "—") : String(maxGen);

  children.push(
    heading("Family Tree at a Glance", 1),
    table2Col([
      ...(filterDescription ? [["Showing", filterDescription]] : []),
      ["Total Individuals", totalIndividuals.toLocaleString()],
      ["Total Families", totalFamilies.toLocaleString()],
      ["Living (protected)", livingCount.toLocaleString()],
      ["Deceased", deceasedCount.toLocaleString()],
      ["Note", "Individual count excludes living people"],
      ["Generations", filterDescription ? genRangeShown : String(maxGen)],
    ]),
    divider(),
    heading("How This Book Was Made", 1),
    body("This book was generated from a GEDCOM family tree using the open-source family-tree project."),
    body("Preserved with family-tree — github.com/sudostacks/family-tree"),
  );

  // Image credits
  if (imageCredits.length) {
    children.push(
      new Paragraph({ pageBreakBefore: true }),
      heading("Image Credits", 1),
      ...imageCredits.slice(0, 200).map((c) => body(`${c.title} — ${c.license || "license"}${c.attribution ? ` — ${c.attribution}` : ""}`)),
    );
  }

  // Surname index
  children.push(new Paragraph({ pageBreakBefore: true }), heading("Index of Surnames", 1));
  const surnameIndex = Array.from(surnameCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
    .map(([s, count]) => `${s} (${count})`);
  children.push(...bulletList(surnameIndex.length ? surnameIndex : ["No surnames found."], numberingRef));

  if (capMessage) {
    children.push(new Paragraph({ pageBreakBefore: true }), heading("Note", 1), body(capMessage));
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 22 },
          paragraph: { spacing: { line: 312 } },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: numberingRef,
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 260 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH_DXA, height: PAGE_HEIGHT_DXA },
            margin: { top: MARGIN_DXA, bottom: MARGIN_DXA, left: MARGIN_DXA, right: MARGIN_DXA },
          },
        },
        footers: { default: buildFooter({ surname: mostCommonSurname }) },
        children,
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);

  console.log(`Family book generated: reports/family-book-${dateStr}.docx`);
  console.log(`Chapters: ${genNumbers.length} generations`);
  console.log(`Individuals featured: ${fullCount} full, ${briefCount} brief, ${rosterCount} roster`);
  console.log(`Images embedded: ${localImages} local, ${wikimediaImages} Wikimedia`);
  console.log(`Estimated pages: ~${estimatedPages}`);
  console.log(`Narratives: ${aiNarratives} AI-generated, ${templateNarratives} templated`);
}

generateBook().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
