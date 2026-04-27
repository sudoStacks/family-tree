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

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const PAGE_WIDTH_DXA = 12240;
const PAGE_HEIGHT_DXA = 15840;
const MARGIN_DXA = 1440;
const CONTENT_WIDTH_DXA = 9360;

function parseArgs(argv) {
  const args = {
    generation: null,
    surname: null,
    refresh: false,
    noImages: false,
    noAi: false,
    noPlaces: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--generation") args.generation = Number(argv[i + 1] || ""), i++;
    else if (a === "--surname") args.surname = String(argv[i + 1] || ""), i++;
    else if (a === "--refresh") args.refresh = true;
    else if (a === "--no-images") args.noImages = true;
    else if (a === "--no-ai") args.noAi = true;
    else if (a === "--no-places") args.noPlaces = true;
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

function displayName(person) {
  const full = person?.name?.full;
  if (full) return String(full).replace(/\s+/g, " ").trim();
  const parts = [person?.name?.given, person?.name?.surname].filter(Boolean);
  return parts.join(" ").trim() || "Unknown";
}

function firstName(person) {
  const given = String(person?.name?.given || "").trim();
  return given.split(/\s+/).filter(Boolean)[0] || displayName(person).split(/\s+/)[0] || "They";
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
    children: [
      new TextRun({
        text: String(text ?? ""),
        font: "Arial",
        size: 22,
      }),
    ],
    spacing: { after: 120 },
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
      () =>
        new TableCell({
          width: { size: 4680, type: WidthType.DXA },
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
          width: { size: 4680, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [new Paragraph({ children: [new TextRun({ text: r[0], font: "Arial", size: 22, bold: true })] })],
        }),
        new TableCell({
          width: { size: 4680, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [new Paragraph({ children: [new TextRun({ text: r[1], font: "Arial", size: 22 })] })],
        }),
      ],
    });
  });
  return new Table({
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

function buildGenerationMap({ individuals, families }) {
  const personById = new Map(individuals.filter((p) => p?.id).map((p) => [p.id, p]));

  const childrenByParent = new Map();
  for (const fam of families) {
    const children = Array.isArray(fam?.children) ? fam.children : [];
    const parents = [fam?.husband, fam?.wife].filter(Boolean);
    for (const parentId of parents) {
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, new Set());
      const set = childrenByParent.get(parentId);
      for (const childId of children) set.add(childId);
    }
  }

  const roots = individuals
    .filter((p) => p?.id)
    .filter((p) => !Array.isArray(p.familiesAsChild) || p.familiesAsChild.length === 0)
    .map((p) => p.id);

  const generation = new Map();
  const queue = [];
  for (const r of roots) {
    generation.set(r, 1);
    queue.push(r);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const g = generation.get(current);
    const kids = childrenByParent.get(current);
    if (!kids) continue;
    for (const childId of kids) {
      if (!personById.has(childId)) continue;
      const nextG = g + 1;
      if (!generation.has(childId) || nextG < generation.get(childId)) {
        generation.set(childId, nextG);
        queue.push(childId);
      }
    }
  }

  const maxGen = Math.max(0, ...Array.from(generation.values()));
  return { generation, maxGen, childrenByParent, personById };
}

function readHistoricalContext() {
  const p = path.join(projectRoot, "data", "historical-context.json");
  const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.events)) return parsed.events;
  throw new Error("historical-context.json must be an array or an object with an events[] array");
}

function inferContinentFromCountry(country) {
  const c = String(country || "").toLowerCase();
  if (!c) return "";
  if (/(united states|usa|canada|mexico|brazil|argentina|chile|peru|colombia|haiti|cuba|jamaica|venezuela)/.test(c)) {
    return "Americas";
  }
  if (/(england|scotland|wales|ireland|uk|united kingdom|france|germany|italy|spain|portugal|poland|ukraine|russia|sweden|norway|denmark|finland|czech|bohemia|austria|hungary|greece|turkey|netherlands|belgium)/.test(c)) {
    return "Europe";
  }
  if (/(china|japan|korea|india|pakistan|bangladesh|vietnam|thailand|philippines|indonesia|malaysia|singapore|afghanistan|iran|iraq|syria|israel|palestine|saudi|arabia|egypt)/.test(c)) {
    return "Asia";
  }
  if (/(nigeria|ethiopia|kenya|ghana|south africa|rwanda|uganda|sudan|algeria|morocco|tunisia|angola|congo|zimbabwe)/.test(c)) {
    return "Africa";
  }
  if (/(australia|new zealand|oceania)/.test(c)) {
    return "Oceania";
  }
  if (/(middle east)/.test(c)) return "Middle East";
  return "";
}

function matchEventsForPerson(person, events) {
  const by = yearFromISO(person?.birth?.dateISO);
  if (by === null) return [];
  const dyRaw = yearFromISO(person?.death?.dateISO);
  const assumedDeath = dyRaw ?? by + 80;
  const birthCountry = countryFromPlace(person?.birth?.place || "");
  const birthContinent = inferContinentFromCountry(birthCountry);

  const scored = events
    .map((e) => {
      if (!e || typeof e !== "object") return null;
      const start = Number(e.startYear);
      const end = Number(e.endYear);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

      // Must overlap a plausible lifetime window.
      const overlapsLifetime = end >= by && start <= assumedDeath;
      if (!overlapsLifetime) return null;

      // Prefer awareness years (10-50).
      const mid = Math.round((start + end) / 2);
      const ageAtMid = mid - by;
      let score = 0;
      if (ageAtMid >= 10 && ageAtMid <= 50) score += 4;
      else if (ageAtMid >= 0 && ageAtMid <= 80) score += 1;

      // Origin match (highest priority).
      const origins = Array.isArray(e.relevantOrigins) ? e.relevantOrigins : [];
      const birthLower = birthCountry.toLowerCase();
      if (birthLower && origins.some((o) => birthLower.includes(String(o).toLowerCase()))) score += 6;

      // Continent match (next priority).
      const continent = String(e.continent || "").toLowerCase();
      if (birthContinent && continent && continent === birthContinent.toLowerCase()) score += 3;

      // Always allow Global events, but don't dominate.
      const region = String(e.region || "");
      if (region === "Global") score += 2;

      return { ...e, _score: score, _region: region };
    })
    .filter(Boolean)
    .sort((a, b) => b._score - a._score);

  const globals = scored.filter((e) => e._region === "Global").slice(0, 2);
  const nonGlobals = scored.filter((e) => e._region !== "Global");

  const selected = [];
  for (const e of globals) selected.push(e);
  for (const e of nonGlobals) {
    if (selected.length >= 5) break;
    if (selected.some((x) => x.event === e.event && x.startYear === e.startYear && x.endYear === e.endYear)) continue;
    selected.push(e);
  }
  return selected.slice(0, 5);
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

async function imageRunFromFile(imagePath) {
  const input = fs.readFileSync(imagePath);
  const resized = await sharp(input).resize({ width: 800, withoutEnlargement: true }).toBuffer();
  return new ImageRun({
    data: resized,
    transformation: { width: 400, height: 300 },
  });
}

function placeholderBox(text) {
  return new Table({
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

  // Marriage + spouse
  const fams = Array.isArray(person?.familiesAsSpouse) ? person.familiesAsSpouse : [];
  if (fams.length) {
    const fam = familiesById.get(fams[0]);
    if (fam) {
      const spouseId = fam.husband === person.id ? fam.wife : fam.husband;
      const spouse = spouseId ? personById.get(spouseId) : null;
      const year = yearFromISO(fam?.marriage?.dateISO);
      const place = fam?.marriage?.place || "";
      if (spouse) {
        lines.push(`Married: ${displayName(spouse)}${year ? `, ${year}` : ""}${place ? `, ${place}` : ""}`);
      }
      const children = Array.isArray(fam?.children) ? fam.children : [];
      const childNames = children
        .map((cid) => personById.get(cid))
        .filter(Boolean)
        .slice(0, 12)
        .map(displayName);
      if (childNames.length) lines.push(`Children: ${childNames.join(", ")}`);
    }
  }

  const text = lines.length ? lines.join("  ") : "Family connections: (not enough data yet)";
  return shadedBlock({ text, fill: "F2F2F2" });
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
      regionPeople.get(key).push({ name: displayName(p), year: y });
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

  const jsonPath = getLatestConvertedJsonPath();
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const individuals = Array.isArray(data.individuals) ? data.individuals : [];
  const families = Array.isArray(data.families) ? data.families : [];
  const familiesById = new Map(families.filter((f) => f?.id).map((f) => [f.id, f]));

  const { generation, maxGen, childrenByParent, personById } = buildGenerationMap({ individuals, families });
  const events = readHistoricalContext();

  const deceased = individuals.filter((p) => !isLiving(p));
  const surnameCounts = new Map();
  for (const p of deceased) {
    const s = normalizeSurname(p?.name?.surname);
    if (!s) continue;
    surnameCounts.set(s, (surnameCounts.get(s) || 0) + 1);
  }
  const topSurnames = Array.from(surnameCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([s]) => s);
  const mostCommonSurname = topSurnames[0] || "Family";
  const secondSurname = topSurnames[1] || "Friends";

  const birthYears = deceased.map((p) => yearFromISO(p?.birth?.dateISO)).filter((y) => y !== null);
  const earliestYear = birthYears.length ? Math.min(...birthYears) : null;
  const latestYear = birthYears.length ? Math.max(...birthYears) : null;

  const dateStr = format(new Date(), "yyyy-MM-dd");
  const generatedDate = format(new Date(), "MMMM d, yyyy");

  const outDir = path.join(projectRoot, "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `family-book-${dateStr}.docx`);

  // Selection defaults + page estimate
  const includeSurname = args.surname ? normalizeSurname(args.surname) : null;
  const includeGen = Number.isFinite(args.generation) ? args.generation : null;

  const genBuckets = new Map();
  for (const p of deceased) {
    const g = generation.get(p.id) || null;
    if (!g) continue;
    if (includeGen && g !== includeGen) continue;
    if (includeSurname && normalizeSurname(p?.name?.surname) !== includeSurname) continue;
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
  if (!includeGen && !includeSurname && estimatedPages > pageCap) {
    capMessage = `Estimated pages (~${estimatedPages}) exceeds cap (${pageCap}). Consider using --generation or --surname.`;
  }

  const imageCredits = [];
  let localImages = 0;
  let wikimediaImages = 0;
  let aiNarratives = 0;
  let templateNarratives = 0;

  const numberingRef = "book-bullets";

  const children = [];

  // Cover page
  children.push(
    shadedBlock({ text: "", fill: "FAF6F0" }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      shading: { type: ShadingType.CLEAR, fill: "FAF6F0" },
      spacing: { before: 800, after: 200 },
      children: [
        new TextRun({
          text: `${mostCommonSurname} & ${secondSurname} Families`,
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
          children: [new TextRun({ text: displayName(earliestPerson), font: "Arial", size: 18, italics: true, color: "666666" })],
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
    const years = allInGen.map((p) => yearFromISO(p?.birth?.dateISO)).filter((y) => y !== null);
    const minY = years.length ? Math.min(...years) : null;
    const maxY = years.length ? Math.max(...years) : null;
    const decadeRange = minY !== null && maxY !== null ? `${Math.floor(minY / 10) * 10}s–${Math.floor(maxY / 10) * 10}s` : "—";
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
            placeImage = await getPlaceImage(regionName, decade);
          } catch {
            placeImage = null;
          }
        }
        try {
          summary = await getPlaceSummary(regionName, decade);
        } catch {
          summary = null;
        }

        // Historical context bullets (use funFact)
        const relevantEvents = events
          .filter((e) => {
            const origins = Array.isArray(e?.relevantOrigins) ? e.relevantOrigins : [];
            const regionLower = regionName.toLowerCase();
            return origins.some((o) => regionLower.includes(String(o).toLowerCase()));
          })
          .filter((e) => (earliest === null || e.endYear >= earliest) && (latest === null || e.startYear <= latest))
          .slice(0, 5);

        children.push(
          heading(`The ${topSurname} Homeland: ${regionName}`, 1),
          divider(),
        );

        if (placeImage?.cachePath) {
          try {
            const run = await imageRunFromFile(placeImage.cachePath);
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
            relevantEvents.length ? relevantEvents.map((e) => e.funFact) : ["No matching historical context found for this region yet."],
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
      const mid = minY !== null && maxY !== null ? Math.round((minY + maxY) / 2) : null;
      if (mid === null) return "Did you know? Families often moved because of jobs, land, or safety.";
      const pick = events.find((e) => mid >= e.startYear && mid <= e.endYear) || events[0];
      return pick?.funFact || "Did you know? Every generation lived through new inventions and new challenges.";
    })();

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
      shadedBlock({ text: `“${chapterQuote}”`, fill: "FFF9C4", borderColor: "F0C040" }),
      new Paragraph({ pageBreakBefore: true }),
    );

    // Era introduction block
    const eraEvent = (() => {
      const mid = minY !== null && maxY !== null ? Math.round((minY + maxY) / 2) : null;
      if (mid === null) return null;
      return events.find((e) => mid >= e.startYear && mid <= e.endYear) || null;
    })();
    if (eraEvent) {
      children.push(
        heading("Era Introduction", 2),
        body(`${eraEvent.event}`),
        body(`${eraEvent.funFact}`),
        divider(),
      );
    }

    // Full spreads (two-column section simulated by short table with 2 cells)
    const funFactsForGen = events.filter((e) => minY !== null && maxY !== null && e.startYear <= maxY && e.endYear >= minY);
    let sidebarCounter = 0;
    const referencedRegionsThisGen = new Set();
    const genPlaceIndex = args.noPlaces ? null : buildGenerationPlaceIndex({ people: allInGen, familiesById, personById });

    for (const person of bucket.full) {
      const personSurname = normalizeSurname(person?.name?.surname);
      if (includeSurname && personSurname !== includeSurname) continue;

      const personEvents = matchEventsForPerson(person, events);
      const { text: narrative, source } = await getNarrative(person, { events: personEvents }, { refresh: args.refresh, noAi: args.noAi });
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
              const img = await getCachedOrFetchCommonsImage(query);
              if (img.cachePath) {
                imageRun = await imageRunFromFile(img.cachePath);
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
      leftChildren.push(
        new Paragraph({
          children: [new TextRun({ text: displayName(person), font: "Arial", size: 36, bold: true })],
        }),
        new Paragraph({ children: [new TextRun({ text: lifeLine, font: "Arial", size: 22, color: "666666" })] }),
        divider(),
      );

      if (imageRun) {
        leftChildren.push(
          new Paragraph({ alignment: AlignmentType.CENTER, children: [imageRun], spacing: { after: 80 } }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: caption || "", font: "Arial", size: 18, italics: true, color: "666666" })],
          }),
        );
      } else {
        const initials = firstName(person).slice(0, 1).toUpperCase() || "?";
        leftChildren.push(placeholderBox(`${initials} — ${person?.birth?.place ? person.birth.place : "No image found"}`));
      }

      const rightChildren = [];
      rightChildren.push(
        new Paragraph({
          children: [new TextRun({ text: `About ${firstName(person)}`, font: "Arial", size: 28, bold: true, color: "1F3864" })],
        }),
        new Paragraph({ children: [new TextRun({ text: narrative, font: "Arial", size: 22 })] }),
        divider(),
        new Paragraph({
          children: [new TextRun({ text: "Life & Times", font: "Arial", size: 26, bold: true, color: "2E75B6" })],
        }),
      );
      const bullets = personEvents.map((e) => `${e.event}: ${e.funFact}`).slice(0, 5);
      rightChildren.push(...bulletList(bullets.length ? bullets : ["No era facts available yet."], numberingRef));

      rightChildren.push(
        divider(),
        new Paragraph({
          children: [new TextRun({ text: "Family connections", font: "Arial", size: 26, bold: true, color: "2E75B6" })],
        }),
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
        width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
        rows: [
            new TableRow({
              children: [
                new TableCell({
                  width: { size: 4600, type: WidthType.DXA },
                  margins: { top: 80, bottom: 80, left: 120, right: 120 },
                  children: leftChildren,
                }),
                new TableCell({
                  width: { size: 4760, type: WidthType.DXA },
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

            let placeImage = null;
            if (!args.noImages) {
              try {
                placeImage = await getPlaceImage(placeName, decade);
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
                const run = await imageRunFromFile(placeImage.cachePath);
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
      if (sidebarCounter % 4 === 0 && funFactsForGen.length) {
        const fact = funFactsForGen[sidebarCounter % funFactsForGen.length];
        children.push(shadedBlock({ text: `Did you know? ${fact.funFact}`, fill: "FFF9C4", borderColor: "F0C040" }));
      }

      // Rate limit AI calls
      await sleep(2000);
    }

    // Brief cards
    for (const person of bucket.brief) {
      const personSurname = normalizeSurname(person?.name?.surname);
      if (includeSurname && personSurname !== includeSurname) continue;
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
        displayName(p),
        p?.birth?.date ? String(yearFromISO(p.birth.dateISO) ?? "—") : "—",
        p?.death?.date ? String(yearFromISO(p.death.dateISO) ?? "—") : "—",
      ]);
      children.push(
        heading("Generation Roster (limited details)", 2),
        new Table({
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
    const topPlaces = allInGen
      .map((p) => stateFromPlace(p?.birth?.place || ""))
      .filter(Boolean);
    const top1 = pickMostCommon(topPlaces);
    const top2 = pickMostCommon(topPlaces.filter((x) => x !== top1));
    const top3 = pickMostCommon(topPlaces.filter((x) => x !== top1 && x !== top2));
    const familiesInGen = new Set();
    for (const p of allInGen) {
      for (const fid of Array.isArray(p?.familiesAsSpouse) ? p.familiesAsSpouse : []) familiesInGen.add(fid);
    }

    children.push(
      new Paragraph({ pageBreakBefore: true }),
      heading(`Generation ${g} Summary`, 1),
      table2Col([
        ["Individuals", String(allInGen.length)],
        ["Top places", [top1, top2, top3].filter(Boolean).join(", ") || "—"],
        ["Families represented", String(familiesInGen.size)],
        ["A simple note", "This generation connects family units that shaped the next chapter."],
      ]),
      new Paragraph({ pageBreakBefore: true }),
    );
  }

  // Back matter — condensed stats
  const totalIndividuals = individuals.length;
  const totalFamilies = families.length;
  const livingCount = individuals.filter(isLiving).length;
  const deceasedCount = totalIndividuals - livingCount;

  children.push(
    heading("Family Tree at a Glance", 1),
    table2Col([
      ["Total Individuals", totalIndividuals.toLocaleString()],
      ["Total Families", totalFamilies.toLocaleString()],
      ["Living (protected)", livingCount.toLocaleString()],
      ["Deceased", deceasedCount.toLocaleString()],
      ["Generations", String(maxGen)],
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
