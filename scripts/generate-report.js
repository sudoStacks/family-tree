#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { format } from "date-fns";
import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableOfContents,
  TableRow,
  TextRun,
  WidthType,
  Packer,
} from "docx";

import { getLatestConvertedJsonPath } from "./_json-latest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");

const PAGE_WIDTH_DXA = 12240;
const PAGE_HEIGHT_DXA = 15840;
const MARGIN_DXA = 1440;
const CONTENT_WIDTH_DXA = 9360;

function parseArgs(argv) {
  const args = {
    surname: null,
    surnames: null,
    generation: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--surname") args.surname = argv[++i] || null;
    else if (a === "--surnames") args.surnames = argv[++i] || null;
    else if (a === "--generation") {
      const n = Number(argv[++i]);
      args.generation = Number.isFinite(n) ? n : null;
    }
  }
  return args;
}

function yearFromISO(dateISO) {
  if (!dateISO || typeof dateISO !== "string") return null;
  const m = dateISO.match(/^(\d{4})-/);
  if (!m) return null;
  const year = Number(m[1]);
  return Number.isFinite(year) ? year : null;
}

function normalizePlaceParts(place) {
  return String(place || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function getCountry(place) {
  const parts = normalizePlaceParts(place);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

function getState(place) {
  const parts = normalizePlaceParts(place);
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

function displayName(person) {
  const full = person?.name?.full;
  if (full) return String(full).replace(/\s+/g, " ").trim();
  const parts = [person?.name?.given, person?.name?.surname].filter(Boolean);
  return parts.join(" ").trim() || "Unknown";
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

function decadeLabel(year) {
  if (!Number.isFinite(year)) return "";
  const d = Math.floor(year / 10) * 10;
  return `${d}s`;
}

function levenshtein(a, b) {
  const s = String(a || "");
  const t = String(b || "");
  if (s === t) return 0;
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;

  const dp = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) dp[j] = j;

  for (let i = 1; i <= s.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const tmp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1, // deletion
        dp[j - 1] + 1, // insertion
        prev + cost, // substitution
      );
      prev = tmp;
    }
  }
  return dp[t.length];
}

function heading1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [
      new TextRun({ text, font: "Arial", size: 32, bold: true, color: "1F3864" }),
    ],
  });
}

function heading2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [
      new TextRun({ text, font: "Arial", size: 26, bold: true, color: "2E75B6" }),
    ],
  });
}

function body(text) {
  return new Paragraph({
    children: [new TextRun({ text, font: "Arial", size: 22 })],
    spacing: { line: 276 },
  });
}

function buildFooter() {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: "Page ", font: "Arial", size: 20 }),
          new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 20 }),
          new TextRun({ text: " of ", font: "Arial", size: 20 }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], font: "Arial", size: 20 }),
        ],
      }),
    ],
  });
}

function buildHeaderRow(cells, { fill, textColor, columnWidths }) {
  return new TableRow({
    children: cells.map(
      (text, idx) =>
        new TableCell({
          width: columnWidths?.[idx] ? { size: columnWidths[idx], type: WidthType.DXA } : undefined,
          shading: { type: ShadingType.CLEAR, fill, color: "auto" },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text,
                  bold: true,
                  color: textColor,
                  font: "Arial",
                  size: 22,
                }),
              ],
            }),
          ],
        }),
    ),
  });
}

function shadedRowFill(index) {
  return index % 2 === 0 ? "FFFFFF" : "F2F2F2";
}

function toCell(value) {
  if (value && typeof value === "object" && "text" in value) return value;
  return { text: String(value ?? ""), bold: false };
}

function makeTable({
  header,
  rows,
  columnWidths,
  headerFill = "1F3864",
  headerTextColor = "FFFFFF",
  rowFillFn = shadedRowFill,
}) {
  const inferredWidths = (() => {
    if (Array.isArray(columnWidths) && columnWidths.length) return columnWidths;
    const cols = header?.length || rows?.[0]?.length || 0;
    if (!cols) return [];
    const w = Math.floor(CONTENT_WIDTH_DXA / cols);
    const out = Array.from({ length: cols }, () => w);
    // Adjust last column to ensure exact sum of 9360.
    out[out.length - 1] += CONTENT_WIDTH_DXA - out.reduce((a, b) => a + b, 0);
    return out;
  })();

  const tableRows = [];
  if (header) {
    tableRows.push(buildHeaderRow(header, { fill: headerFill, textColor: headerTextColor, columnWidths: inferredWidths }));
  }

  rows.forEach((row, idx) => {
    const fill = rowFillFn(idx);
    tableRows.push(
      new TableRow({
        children: row.map((value, cellIdx) => {
          const cell = toCell(value);
          return new TableCell({
            width: inferredWidths?.[cellIdx]
              ? { size: inferredWidths[cellIdx], type: WidthType.DXA }
              : undefined,
            shading: { type: ShadingType.CLEAR, fill },
            margins: { top: 80, bottom: 80, left: 120, right: 120 },
            children: [
              new Paragraph({
                children: [
                  new TextRun({
                    text: cell.text,
                    font: "Arial",
                    size: 22,
                    bold: Boolean(cell.bold),
                  }),
                ],
              }),
            ],
          });
        }),
      }),
    );
  });

  return new Table({
    layout: { type: TableLayoutType.FIXED },
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    rows: tableRows,
  });
}

function makeOutlineRule() {
  return new Paragraph({
    border: {
      bottom: {
        color: "1F3864",
        space: 2,
        size: 6,
      },
    },
  });
}

function countSourceCitations(individuals) {
  let count = 0;
  for (const p of individuals) {
    count += Array.isArray(p?.birth?.sourceRefs) ? p.birth.sourceRefs.length : 0;
    count += Array.isArray(p?.death?.sourceRefs) ? p.death.sourceRefs.length : 0;
    count += Array.isArray(p?.sources) ? p.sources.length : 0;
  }
  return count;
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

function scoreDistribution(scores) {
  const buckets = [
    { label: "80-100%", min: 80, max: 100 },
    { label: "60-79%", min: 60, max: 79 },
    { label: "40-59%", min: 40, max: 59 },
    { label: "20-39%", min: 20, max: 39 },
    { label: "0-19%", min: 0, max: 19 },
  ];

  const out = buckets.map((b) => ({ ...b, count: 0 }));
  for (const s of scores) {
    const bucket = out.find((b) => s >= b.min && s <= b.max);
    if (bucket) bucket.count++;
  }
  return out;
}

function decadeCounts(individuals) {
  const counts = new Map();
  let minDecade = null;
  let maxDecade = null;

  for (const p of individuals) {
    const y = yearFromISO(p?.birth?.dateISO);
    if (y === null) continue;
    const decade = Math.floor(y / 10) * 10;
    counts.set(decade, (counts.get(decade) || 0) + 1);
    minDecade = minDecade === null ? decade : Math.min(minDecade, decade);
    maxDecade = maxDecade === null ? decade : Math.max(maxDecade, decade);
  }

  const series = [];
  if (minDecade === null || maxDecade === null) return series;
  for (let d = minDecade; d <= maxDecade; d += 10) {
    series.push({ decade: d, births: counts.get(d) || 0 });
  }
  return series;
}

function buildGenerationStats({ individuals, families }) {
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
  const rows = [];
  for (let g = 1; g <= maxGen; g++) {
    const ids = Array.from(generation.entries())
      .filter(([, gen]) => gen === g)
      .map(([id]) => id);
    const years = ids
      .map((id) => yearFromISO(personById.get(id)?.birth?.dateISO))
      .filter((y) => y !== null);
    const avgBirthYear =
      years.length > 0 ? Math.round(years.reduce((a, b) => a + b, 0) / years.length) : null;
    rows.push({ generation: g, count: ids.length, avgBirthYear });
  }

  return { totalGenerations: maxGen, rows, childrenByParent };
}

function mediaReferenceCount(individuals) {
  let count = 0;
  for (const p of individuals) {
    const rawTags = p?.rawTags || {};
    const objes = Array.isArray(rawTags?.OBJE) ? rawTags.OBJE : [];
    count += objes.length;
  }
  return count;
}

function calcSpanYears(individuals) {
  const birthYears = individuals.map((p) => yearFromISO(p?.birth?.dateISO)).filter((y) => y !== null);
  const deathYears = individuals.map((p) => yearFromISO(p?.death?.dateISO)).filter((y) => y !== null);
  const earliestBirth = birthYears.length ? Math.min(...birthYears) : null;
  const latestDeath = deathYears.length ? Math.max(...deathYears) : null;
  const latestBirth = birthYears.length ? Math.max(...birthYears) : null;
  const end = latestDeath ?? latestBirth;
  if (earliestBirth === null || end === null) return null;
  return { earliestBirth, latestBirth, latestDeath, span: end - earliestBirth };
}

function mostCommonSurname(individuals) {
  const counts = new Map();
  for (const p of individuals) {
    const s = p?.name?.surname;
    if (!s) continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let best = { surname: "Family", count: 0 };
  for (const [surname, count] of counts.entries()) {
    if (count > best.count) best = { surname, count };
  }
  return best.surname;
}

function topNByCount(map, n) {
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
}

function coverageRowShading(coveragePct) {
  if (coveragePct >= 80) return "C6EFCE";
  if (coveragePct >= 50) return "FFEB9C";
  return "FFC7CE";
}

function makeCoverageTable(rows) {
  const columnWidths = [2340, 2340, 2340, 2340];
  const headerRow = buildHeaderRow(["Field", "Populated", "Missing", "Coverage"], {
    fill: "1F3864",
    textColor: "FFFFFF",
    columnWidths,
  });

  const bodyRows = rows.map((r) => {
    const fill = coverageRowShading(r.coverage);
    const cells = [
      r.field,
      String(r.populated),
      String(r.missing),
      `${r.coverage}%`,
    ].map(
      (text) =>
        new TableCell({
          width: { size: 2340, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill },
          margins: { top: 80, bottom: 80, left: 120, right: 120 },
          children: [new Paragraph({ children: [new TextRun({ text, font: "Arial", size: 22 })] })],
        }),
    );
    return new TableRow({ children: cells });
  });

  return new Table({
    layout: { type: TableLayoutType.FIXED },
    width: { size: CONTENT_WIDTH_DXA, type: WidthType.DXA },
    rows: [headerRow, ...bodyRows],
  });
}

function findImmigrants({ deceased, childrenByParent, personById }) {
  const immigrants = [];
  for (const p of deceased) {
    const origin = p?.birth?.place || "";
    const originCountry = getCountry(origin);
    if (!originCountry || originCountry.toLowerCase() === "usa" || originCountry.toLowerCase() === "united states") {
      continue;
    }

    // BFS descendants looking for US-born records
    const queue = [p.id];
    const seen = new Set(queue);
    let earliestUsYear = null;
    const usStates = new Map();

    while (queue.length > 0) {
      const current = queue.shift();
      const kids = childrenByParent.get(current);
      if (!kids) continue;
      for (const childId of kids) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        queue.push(childId);
        const child = personById.get(childId);
        if (!child) continue;
        const bp = child?.birth?.place || "";
        const country = getCountry(bp).toLowerCase();
        if (country === "usa" || country === "united states") {
          const y = yearFromISO(child?.birth?.dateISO);
          if (y !== null) earliestUsYear = earliestUsYear === null ? y : Math.min(earliestUsYear, y);
          const st = getState(bp);
          if (st) usStates.set(st, (usStates.get(st) || 0) + 1);
        }
      }
    }

    if (earliestUsYear === null) continue;
    const settledState = topNByCount(usStates, 1)[0]?.[0] || "";
    immigrants.push({
      person: p,
      originCountry,
      approxArrival: earliestUsYear ? `${earliestUsYear - 1}` : "",
      settledState,
    });
  }

  return immigrants.slice(0, 20);
}

function personSourceCitationCount(person) {
  let count = 0;
  count += Array.isArray(person?.birth?.sourceRefs) ? person.birth.sourceRefs.length : 0;
  count += Array.isArray(person?.death?.sourceRefs) ? person.death.sourceRefs.length : 0;
  count += Array.isArray(person?.sources) ? person.sources.length : 0;
  return count;
}

function personHasNotableRawTags(person) {
  const rawTags = person?.rawTags || {};
  const keys = rawTags && typeof rawTags === "object" ? Object.keys(rawTags) : [];
  const hit = keys.find((k) => ["MILI", "IMMI", "EMIG", "OCCU"].includes(String(k).toUpperCase()));
  return hit || null;
}

function countChildrenAsParent(person, familiesById) {
  const fams = Array.isArray(person?.familiesAsSpouse) ? person.familiesAsSpouse : [];
  let count = 0;
  for (const fid of fams) {
    const fam = familiesById.get(fid);
    if (!fam) continue;
    count += Array.isArray(fam?.children) ? fam.children.length : 0;
  }
  return count;
}

function topItemsWithExamples(items, limit) {
  const counts = new Map();
  const example = new Map();
  for (const it of items) {
    if (!it?.key) continue;
    counts.set(it.key, (counts.get(it.key) || 0) + 1);
    if (!example.has(it.key) && it.example) example.set(it.key, it.example);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count, example: example.get(key) || "" }));
}

function filterDatasetBySurnameAndGeneration({ individuals, families, surnameSet, generationNumber }) {
  const personByIdAll = new Map(individuals.filter((p) => p?.id).map((p) => [p.id, p]));
  const familiesByIdAll = new Map(families.filter((f) => f?.id).map((f) => [f.id, f]));

  const hasSurnameFilter = surnameSet && surnameSet.size > 0;

  // Step 1: pick "matched" individuals by surname (case-insensitive normalized).
  const matchedIndividuals = hasSurnameFilter
    ? individuals.filter((p) => surnameSet.has(normalizeSurname(p?.name?.surname)))
    : individuals.slice();

  // Step 2: keep families where husband OR wife is a matched individual.
  const matchedIds = new Set(matchedIndividuals.map((p) => p?.id).filter(Boolean));
  const keptFamilyIds = new Set();
  const keepPersonIds = new Set();

  if (!hasSurnameFilter) {
    for (const p of individuals) if (p?.id) keepPersonIds.add(p.id);
    for (const f of families) if (f?.id) keptFamilyIds.add(f.id);
  } else {
    for (const f of families) {
      if (!f?.id) continue;
      if (f?.husband && matchedIds.has(f.husband)) keptFamilyIds.add(f.id);
      else if (f?.wife && matchedIds.has(f.wife)) keptFamilyIds.add(f.id);
    }

    // Step 3: for each kept family, keep both spouses and all children.
    for (const fid of keptFamilyIds) {
      const fam = familiesByIdAll.get(fid);
      if (!fam) continue;
      for (const pid of [fam.husband, fam.wife].filter(Boolean)) keepPersonIds.add(pid);
      for (const cid of Array.isArray(fam?.children) ? fam.children : []) keepPersonIds.add(cid);
    }
  }

  // Step 4: apply generation filter (after surname expansion, so spouse/children are available),
  // then re-expand families to preserve marriage/children context within the generation.
  let filteredIndividuals = Array.from(keepPersonIds).map((id) => personByIdAll.get(id)).filter(Boolean);
  let filteredFamilies = Array.from(keptFamilyIds).map((id) => familiesByIdAll.get(id)).filter(Boolean);

  if (generationNumber && Number.isFinite(generationNumber)) {
    const gen = buildGenerationStats({ individuals: filteredIndividuals, families: filteredFamilies });
    const idsInGen = new Set(
      Array.from(gen.childrenByParent.keys())
        .concat(filteredIndividuals.map((p) => p?.id))
        .filter(Boolean)
        .filter((id) => (gen && gen.rows) || true),
    );
    // We need the exact generation map, not only rows; rebuild with internal helper.
    const { generation: genMap } = (() => {
      const personById = new Map(filteredIndividuals.filter((p) => p?.id).map((p) => [p.id, p]));
      const childrenByParent = new Map();
      for (const fam of filteredFamilies) {
        const children = Array.isArray(fam?.children) ? fam.children : [];
        const parents = [fam?.husband, fam?.wife].filter(Boolean);
        for (const parentId of parents) {
          if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, new Set());
          const set = childrenByParent.get(parentId);
          for (const childId of children) set.add(childId);
        }
      }
      const roots = filteredIndividuals
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
      return { generation };
    })();

    const genKeepIds = new Set(filteredIndividuals.filter((p) => genMap.get(p.id) === generationNumber).map((p) => p.id));

    const keptFamiliesForGen = new Set();
    const expandedPeopleForGen = new Set();
    for (const f of filteredFamilies) {
      if (!f?.id) continue;
      const spouseHit = (f?.husband && genKeepIds.has(f.husband)) || (f?.wife && genKeepIds.has(f.wife));
      if (!spouseHit) continue;
      keptFamiliesForGen.add(f.id);
      for (const pid of [f.husband, f.wife].filter(Boolean)) expandedPeopleForGen.add(pid);
      for (const cid of Array.isArray(f?.children) ? f.children : []) expandedPeopleForGen.add(cid);
    }

    filteredIndividuals = Array.from(expandedPeopleForGen).map((id) => personByIdAll.get(id)).filter(Boolean);
    filteredFamilies = Array.from(keptFamiliesForGen).map((id) => familiesByIdAll.get(id)).filter(Boolean);
  }

  return { individuals: filteredIndividuals, families: filteredFamilies, matchedIndividualsCount: matchedIndividuals.length };
}

async function generate() {
  const args = parseArgs(process.argv.slice(2));
  const jsonPath = getLatestConvertedJsonPath();
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  const allIndividuals = Array.isArray(data.individuals) ? data.individuals : [];
  const allFamilies = Array.isArray(data.families) ? data.families : [];

  const surnameSet = (() => {
    if (args.surnames) {
      const parts = String(args.surnames)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return new Set(parts.map(normalizeSurname));
    }
    if (args.surname) return new Set([normalizeSurname(args.surname)]);
    return new Set();
  })();

  const hasSurnameFilter = surnameSet.size > 0;
  const generationFilter = Number.isFinite(args.generation) ? args.generation : null;

  const filtered = filterDatasetBySurnameAndGeneration({
    individuals: allIndividuals,
    families: allFamilies,
    surnameSet: hasSurnameFilter ? surnameSet : null,
    generationNumber: generationFilter,
  });

  const individuals = filtered.individuals;
  const families = filtered.families;

  const personById = new Map(individuals.filter((p) => p?.id).map((p) => [p.id, p]));
  const familiesById = new Map(families.filter((f) => f?.id).map((f) => [f.id, f]));

  const filterSummary = (() => {
    if (!hasSurnameFilter && !generationFilter) return null;
    const surnameList = Array.from(surnameSet).filter(Boolean).map((s) => s.toLowerCase());
    const parts = [];
    if (surnameList.length) parts.push(`surnames=[${surnameList.join(", ")}]`);
    if (generationFilter) parts.push(`generation=${generationFilter}`);
    return parts.join(" | ");
  })();

  if (filterSummary) {
    console.log(
      `Filter: ${filterSummary} | Matched ${filtered.matchedIndividualsCount.toLocaleString()} of ${allIndividuals.length.toLocaleString()} individuals`,
    );
  }

  const surnameForTitle = mostCommonSurname(individuals);
  const generatedDate = format(new Date(), "MMMM d, yyyy");
  const dateStr = format(new Date(), "yyyy-MM-dd");

  const livingCount = individuals.filter(isLiving).length;
  const deceasedCount = individuals.length - livingCount;
  const deceased = individuals.filter((p) => !isLiving(p));

  const spans = calcSpanYears(individuals);
  const uniqueSurnames = new Set(individuals.map((p) => p?.name?.surname).filter(Boolean)).size;
  const sourceCitations = countSourceCitations(individuals);
  const totalMediaRefs = mediaReferenceCount(individuals);

  const scores = individuals.map(completenessScore);
  const avgCompleteness = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const scoreDist = scoreDistribution(scores);

  const gen = buildGenerationStats({ individuals, families });

  // Geography (deceased only)
  const countryCounts = new Map();
  const stateCounts = new Map();
  for (const p of deceased) {
    const place = p?.birth?.place;
    if (!place) continue;
    const country = getCountry(place);
    const state = getState(place);
    if (country) countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
    if (state) stateCounts.set(state, (stateCounts.get(state) || 0) + 1);
  }

  // Timeline by decade
  const decades = decadeCounts(individuals);
  const maxDecadeBirths = decades.reduce((m, d) => Math.max(m, d.births), 0) || 1;

  // Surnames top 25 with min/max year
  const buildSurnameStats = (people) => {
    const surnameStats = new Map();
    for (const p of people) {
      const s = p?.name?.surname;
      if (!s) continue;
      const y = yearFromISO(p?.birth?.dateISO);
      if (!surnameStats.has(s)) surnameStats.set(s, { count: 0, min: null, max: null });
      const st = surnameStats.get(s);
      st.count++;
      if (y !== null) {
        st.min = st.min === null ? y : Math.min(st.min, y);
        st.max = st.max === null ? y : Math.max(st.max, y);
      }
    }
    return surnameStats;
  };

  const surnameStats = (() => {
    // When surname filter is active, show surnames the filtered set married into (spouse surnames),
    // not only the filtered surname itself.
    if (!hasSurnameFilter) return buildSurnameStats(individuals);
    const stats = new Map();
    for (const f of families) {
      const h = f?.husband ? personById.get(f.husband) : null;
      const w = f?.wife ? personById.get(f.wife) : null;
      const hs = normalizeSurname(h?.name?.surname);
      const ws = normalizeSurname(w?.name?.surname);
      const husbandMatches = hs && surnameSet.has(hs);
      const wifeMatches = ws && surnameSet.has(ws);
      if (!husbandMatches && !wifeMatches) continue;

      const other = husbandMatches ? w : wifeMatches ? h : null;
      if (!other) continue;
      const otherSurname = other?.name?.surname;
      if (!otherSurname) continue;
      const y = yearFromISO(other?.birth?.dateISO);
      if (!stats.has(otherSurname)) stats.set(otherSurname, { count: 0, min: null, max: null });
      const st = stats.get(otherSurname);
      st.count++;
      if (y !== null) {
        st.min = st.min === null ? y : Math.min(st.min, y);
        st.max = st.max === null ? y : Math.max(st.max, y);
      }
    }
    return stats.size ? stats : buildSurnameStats(individuals);
  })();

  const topSurnames = Array.from(surnameStats.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 25)
    .map(([surname, st], idx) => ({ rank: idx + 1, surname, ...st }));

  // Completeness coverage for deceased
  const deceasedCountForCoverage = deceased.length || 1;
  const coverage = (populated) => Math.round((populated / deceasedCountForCoverage) * 100);
  const birthDatePop = deceased.filter((p) => Boolean(p?.birth?.dateISO)).length;
  const birthPlacePop = deceased.filter((p) => Boolean(p?.birth?.place)).length;
  const deathDatePop = deceased.filter((p) => Boolean(p?.death?.dateISO)).length;
  const deathPlacePop = deceased.filter((p) => Boolean(p?.death?.place)).length;
  const sourcePop = deceased.filter(
    (p) =>
      (Array.isArray(p?.birth?.sourceRefs) && p.birth.sourceRefs.length > 0) ||
      (Array.isArray(p?.death?.sourceRefs) && p.death.sourceRefs.length > 0) ||
      (Array.isArray(p?.sources) && p.sources.length > 0),
  ).length;
  const spouseLinkPop = deceased.filter((p) => Array.isArray(p?.familiesAsSpouse) && p.familiesAsSpouse.length > 0).length;

  // Earliest ancestors (deceased only)
  const earliest = deceased
    .map((p) => ({ p, y: yearFromISO(p?.birth?.dateISO) }))
    .filter((x) => x.y !== null)
    .sort((a, b) => a.y - b.y)
    .slice(0, 20);

  // Oldest by age at death
  const ages = deceased
    .map((p) => {
      const by = yearFromISO(p?.birth?.dateISO);
      const dy = yearFromISO(p?.death?.dateISO);
      if (by === null || dy === null) return null;
      return { p, by, dy, age: dy - by };
    })
    .filter(Boolean)
    .sort((a, b) => b.age - a.age)
    .slice(0, 10);

  // Largest families
  const largestFamilies = families
    .map((f) => ({ f, count: Array.isArray(f?.children) ? f.children.length : 0 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Missing & research: broken links
  const personIds = new Set(individuals.map((p) => p?.id).filter(Boolean));
  const familyIds = new Set(families.map((f) => f?.id).filter(Boolean));
  const broken = [];
  for (const f of families) {
    const refs = [f?.husband, f?.wife, ...(Array.isArray(f?.children) ? f.children : [])].filter(Boolean);
    for (const rid of refs) {
      if (!personIds.has(rid)) broken.push(`Family ${f.id} references missing person ${rid}`);
    }
  }
  for (const p of individuals) {
    for (const fid of Array.isArray(p?.familiesAsChild) ? p.familiesAsChild : []) {
      if (!familyIds.has(fid)) broken.push(`Person ${p.id} references missing family (familiesAsChild) ${fid}`);
    }
    for (const fid of Array.isArray(p?.familiesAsSpouse) ? p.familiesAsSpouse : []) {
      if (!familyIds.has(fid)) broken.push(`Person ${p.id} references missing family (familiesAsSpouse) ${fid}`);
    }
  }

  // Priority 1: ancestors (parents/grandparents) of living missing birth date
  const familyById = new Map(families.filter((f) => f?.id).map((f) => [f.id, f]));
  const ancestorSet = new Set();
  const livingPeople = individuals.filter(isLiving);
  for (const lp of livingPeople) {
    const famc = Array.isArray(lp?.familiesAsChild) ? lp.familiesAsChild : [];
    for (const fid of famc) {
      const fam = familyById.get(fid);
      if (!fam) continue;
      const parents = [fam.husband, fam.wife].filter(Boolean);
      for (const pid of parents) {
        ancestorSet.add(pid);
        const parent = personById.get(pid);
        const parentFamc = Array.isArray(parent?.familiesAsChild) ? parent.familiesAsChild : [];
        for (const pfid of parentFamc) {
          const pfam = familyById.get(pfid);
          if (!pfam) continue;
          for (const gpid of [pfam.husband, pfam.wife].filter(Boolean)) ancestorSet.add(gpid);
        }
      }
    }
  }
  const ancestorMissingBirth = Array.from(ancestorSet)
    .map((id) => personById.get(id))
    .filter(Boolean)
    .filter((p) => !p?.birth?.dateISO)
    .slice(0, 30);

  // Priority 3: date errors (birth year > death year)
  const dateErrors = individuals
    .map((p) => {
      const by = yearFromISO(p?.birth?.dateISO);
      const dy = yearFromISO(p?.death?.dateISO);
      if (by === null || dy === null) return null;
      if (by > dy) return { p, by, dy };
      return null;
    })
    .filter(Boolean);

  const immigrants = findImmigrants({ deceased, childrenByParent: gen.childrenByParent, personById });

  // Section 10 — Family surname profiles (deceased only)
  const surnameCounts = new Map();
  const surnameToPeople = new Map();
  for (const p of deceased) {
    const s = normalizeSurname(p?.name?.surname);
    if (!s) continue;
    surnameCounts.set(s, (surnameCounts.get(s) || 0) + 1);
    if (!surnameToPeople.has(s)) surnameToPeople.set(s, []);
    surnameToPeople.get(s).push(p);
  }

  const primaryOrder = Array.from(surnameCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([s]) => s);
  const qualifying = Array.from(surnameCounts.entries())
    .filter(([s, count]) => count >= 10 || primaryOrder.includes(s))
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s);

  const orderedSurnames = (() => {
    if (hasSurnameFilter) {
      const ordered = args.surnames
        ? String(args.surnames).split(",").map((s) => s.trim()).filter(Boolean)
        : args.surname
          ? [String(args.surname)]
          : [];
      const normalized = ordered.map(normalizeSurname).filter(Boolean);
      // Keep only surnames that exist in the filtered data.
      return normalized.filter((s) => surnameCounts.has(s));
    }
    return [...primaryOrder, ...qualifying.filter((s) => !primaryOrder.includes(s))];
  })();

  const outDir = path.join(projectRoot, "reports");
  fs.mkdirSync(outDir, { recursive: true });
  const filterSlugParts = [];
  if (hasSurnameFilter) {
    const ordered = args.surnames
      ? String(args.surnames)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : args.surname
        ? [String(args.surname)]
        : [];
    for (const s of ordered) filterSlugParts.push(slugifySurname(s));
  }
  if (generationFilter) filterSlugParts.push(`gen${generationFilter}`);
  const filterSlug = filterSlugParts.length ? `-${filterSlugParts.join("-")}` : "";
  const outPath = path.join(outDir, `family-tree-report${filterSlug}-${dateStr}.docx`);

  const titleText = (() => {
    const cap = (s) => String(s || "").slice(0, 1).toUpperCase() + String(s || "").slice(1).toLowerCase();
    if (hasSurnameFilter) {
      const ordered = args.surnames
        ? String(args.surnames).split(",").map((s) => s.trim()).filter(Boolean)
        : args.surname
          ? [String(args.surname)]
          : [];
      const names = ordered.map(cap).filter(Boolean);
      const base =
        names.length === 1
          ? `The ${names[0]} Family — Genealogical Report`
          : `The ${names.slice(0, 2).join(" & ")} Families — Genealogical Report`;
      return generationFilter ? `${base.replace(" — Genealogical Report", "")} — Generation ${generationFilter}` : base;
    }
    if (generationFilter) return `${surnameForTitle} Family Tree — Generation ${generationFilter}`;
    return `${surnameForTitle} Family Tree — Full Report`;
  })();

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: "Arial", size: 22 },
          paragraph: { spacing: { line: 276 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH_DXA, height: PAGE_HEIGHT_DXA },
            margin: { top: MARGIN_DXA, bottom: MARGIN_DXA, left: MARGIN_DXA, right: MARGIN_DXA },
          },
        },
        footers: { default: buildFooter() },
        children: [
          // Cover page
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 3000, after: 300 },
            children: [
              new TextRun({ text: titleText, font: "Arial", size: 56, bold: true }),
            ],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            children: [new TextRun({ text: "A Genealogical Summary", font: "Arial", size: 28, bold: true })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 },
            children: [new TextRun({ text: `Generated ${generatedDate}`, font: "Arial", size: 22 })],
          }),
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { after: 600 },
            children: [
              new TextRun({
                text: "Preserved with family-tree — github.com/sudostacks/family-tree",
                font: "Arial",
                size: 22,
              }),
            ],
          }),
          new Paragraph({ pageBreakBefore: true }),

          // TOC page
          heading1("Table of Contents"),
          new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }),
          new Paragraph({ pageBreakBefore: true }),

          // Section 1 — At a Glance
          heading1("1. At a Glance"),
          makeTable({
            header: ["Metric", "Value"],
            headerFill: "D5E8F0",
            headerTextColor: "000000",
            rows: [
              ...(filterSummary ? [["Filter Applied", filterSummary]] : []),
              ["Total Individuals", individuals.length.toLocaleString()],
              ["Total Families", families.length.toLocaleString()],
              ["Living (protected)", livingCount.toLocaleString()],
              ["Deceased", deceasedCount.toLocaleString()],
              ["Total Generations", String(gen.totalGenerations)],
              ["Earliest Known Year", spans?.earliestBirth !== null ? String(spans.earliestBirth) : "—"],
              ["Latest Birth Year", spans?.latestBirth !== null ? String(spans.latestBirth) : "—"],
              ["Span of Records", spans?.span !== null ? `${spans.span} years` : "—"],
              ["Average Completeness", `${avgCompleteness}%`],
              ["Total Media References", totalMediaRefs.toLocaleString()],
              ["Unique Surnames", uniqueSurnames.toLocaleString()],
              ["Source Citations", sourceCitations.toLocaleString()],
            ],
            columnWidths: [4680, 4680],
          }),

          // Section 2 — Timeline
          heading1("2. Timeline"),
          body("Decade-by-decade birth counts:"),
          makeTable({
            header: ["Decade", "Births", "Visual bar"],
            rows: decades.map((d) => {
              const barLen = Math.min(30, Math.round((d.births / maxDecadeBirths) * 30));
              const bar = "█".repeat(barLen);
              return [`${d.decade}s`, String(d.births), bar];
            }),
            columnWidths: [2000, 1500, 5860],
          }),

          // Section 3 — Generations
          heading1("3. Generations"),
          body(`This tree spans ${gen.totalGenerations} generations`),
          makeTable({
            header: ["Generation", "Count", "Avg Birth Year", "Notes"],
            rows: gen.rows.map((r) => [
              String(r.generation),
              String(r.count),
              r.avgBirthYear !== null ? String(r.avgBirthYear) : "—",
              r.generation === 1 ? "Earliest known" : "",
            ]),
            columnWidths: [1500, 1500, 2000, 4360],
          }),

          // Section 4 — Geography
          heading1("4. Geography"),
          heading2("Top Countries of Origin"),
          makeTable({
            header: ["Country", "Individuals", "% of tree"],
            rows: topNByCount(countryCounts, 20).map(([country, count]) => [
              country,
              String(count),
              `${Math.round((count / deceasedCount) * 100)}%`,
            ]),
            columnWidths: [4000, 2000, 3360],
          }),
          heading2("Top States / Regions"),
          makeTable({
            header: ["State/Region", "Individuals", "% of tree"],
            rows: topNByCount(stateCounts, 20).map(([state, count]) => [
              state,
              String(count),
              `${Math.round((count / deceasedCount) * 100)}%`,
            ]),
            columnWidths: [4000, 2000, 3360],
          }),

          // Section 5 — Surnames
          heading1("5. Surnames"),
          makeTable({
            header: ["Rank", "Surname", "Count", "First Recorded", "Most Recent"],
            rows: topSurnames.map((s, idx) => {
              const bold = idx < 3;
              return [
                { text: String(s.rank), bold },
                { text: s.surname, bold },
                { text: String(s.count), bold },
                { text: s.min !== null ? String(s.min) : "—", bold },
                { text: s.max !== null ? String(s.max) : "—", bold },
              ];
            }),
            columnWidths: [900, 3000, 1500, 2000, 1960],
          }),

          // Section 6 — Data Completeness
          heading1("6. Data Completeness"),
          heading2("Field Coverage"),
          makeCoverageTable([
            { field: "Birth Date", populated: birthDatePop, missing: deceasedCount - birthDatePop, coverage: coverage(birthDatePop) },
            { field: "Birth Place", populated: birthPlacePop, missing: deceasedCount - birthPlacePop, coverage: coverage(birthPlacePop) },
            { field: "Death Date", populated: deathDatePop, missing: deceasedCount - deathDatePop, coverage: coverage(deathDatePop) },
            { field: "Death Place", populated: deathPlacePop, missing: deceasedCount - deathPlacePop, coverage: coverage(deathPlacePop) },
            { field: "Source Citation", populated: sourcePop, missing: deceasedCount - sourcePop, coverage: coverage(sourcePop) },
            { field: "Spouse Link", populated: spouseLinkPop, missing: deceasedCount - spouseLinkPop, coverage: coverage(spouseLinkPop) },
          ]),
          heading2("Completeness Score Distribution"),
          makeTable({
            header: ["Score Range", "Count", "% of Tree"],
            rows: scoreDist.map((b) => [
              b.label,
              String(b.count),
              `${Math.round((b.count / individuals.length) * 100)}%`,
            ]),
            columnWidths: [3000, 2000, 4360],
          }),

          // Section 7 — Earliest Known Ancestors
          heading1("7. Earliest Known Ancestors"),
          makeTable({
            header: ["Name", "Born", "Died", "Birthplace", "Notes"],
            rows: earliest.map(({ p, y }) => {
              const dy = yearFromISO(p?.death?.dateISO);
              const approx = p?.birth?.dateQualifier ? "approx." : "";
              const dateError = dy !== null && y !== null && y > dy ? "⚠ date error" : "";
              const notes = [approx, dateError].filter(Boolean).join(" ");
              return [displayName(p), String(y), dy !== null ? String(dy) : "—", p?.birth?.place || "", notes];
            }),
            columnWidths: [3400, 1000, 1000, 2960, 1000],
          }),

          // Section 8 — Notable Records
          heading1("8. Notable Records"),
          heading2("Immigrants"),
          makeTable({
            header: ["Name", "Origin", "Approx. Arrival", "US State Settled"],
            rows: immigrants.map((i) => [
              displayName(i.person),
              i.originCountry,
              i.approxArrival || "—",
              i.settledState || "—",
            ]),
            columnWidths: [3200, 2200, 1800, 3160],
          }),
          heading2("Oldest Individuals"),
          makeTable({
            header: ["Name", "Born", "Died", "Age", "Birthplace"],
            rows: ages.map((a) => [
              displayName(a.p),
              String(a.by),
              String(a.dy),
              a.age > 100 ? `⚠ verify ${a.age}` : String(a.age),
              a.p?.birth?.place || "",
            ]),
            columnWidths: [3400, 1000, 1000, 1200, 2760],
          }),
          heading2("Largest Families"),
          makeTable({
            header: ["Parents", "Married", "Children", "Birthplace of Father"],
            rows: largestFamilies.map(({ f, count }) => {
              const father = personById.get(f?.husband);
              const mother = personById.get(f?.wife);
              const parents = [father ? displayName(father) : "", mother ? displayName(mother) : ""]
                .filter(Boolean)
                .join(" + ");
              const married = f?.marriage?.dateISO ? String(yearFromISO(f.marriage.dateISO) ?? "") : "";
              return [parents, married || "—", String(count), father?.birth?.place || ""];
            }),
            columnWidths: [4200, 1200, 1200, 2760],
          }),

          // Section 9 — Missing & Needs Research
          heading1("9. Missing & Needs Research"),
          heading2("Priority 1 — Direct ancestors missing birth date"),
          makeTable({
            header: ["Name", "Relationship Context", "Missing Fields"],
            rows: ancestorMissingBirth.map((p) => [displayName(p), "Ancestor of living person", "Birth Date"]),
            columnWidths: [4200, 3200, 1960],
          }),
          heading2("Priority 2 — Individuals with broken family links"),
          makeTable({
            header: ["Issue"],
            rows: broken.length ? broken.map((x) => [x]) : [["None detected"]],
            columnWidths: [CONTENT_WIDTH_DXA],
          }),
          heading2("Priority 3 — Date errors"),
          makeTable({
            header: ["Person", "Birth Year", "Death Year", "Notes"],
            rows: dateErrors.length
              ? dateErrors.map(({ p, by, dy }) => [p.id, String(by), String(dy), "birth > death"])
              : [["None detected", "", "", ""]],
            columnWidths: [2000, 1500, 1500, 4360],
          }),

          // Section 10 — Family Surname Profiles
          heading1("10. Family Surname Profiles"),
          body(
            "Surname profiles are generated for major family lines (10+ individuals), excluding living individuals.",
          ),
          ...orderedSurnames.flatMap((surname, idx) => {
            const people = surnameToPeople.get(surname) || [];
            if (people.length === 0) return [];

            const males = people.filter((p) => p?.sex === "M").length;
            const females = people.filter((p) => p?.sex === "F").length;

            const birthYears = people
              .map((p) => yearFromISO(p?.birth?.dateISO))
              .filter((y) => y !== null);
            const earliestYear = birthYears.length ? Math.min(...birthYears) : null;
            const mostRecentYear = birthYears.length ? Math.max(...birthYears) : null;

            const earliestPerson =
              earliestYear === null
                ? null
                : people
                    .filter((p) => yearFromISO(p?.birth?.dateISO) === earliestYear)
                    .sort((a, b) => displayName(a).localeCompare(displayName(b)))[0];
            const recentPerson =
              mostRecentYear === null
                ? null
                : people
                    .filter((p) => yearFromISO(p?.birth?.dateISO) === mostRecentYear)
                    .sort((a, b) => displayName(a).localeCompare(displayName(b)))[0];

            // Peak decade for births
            const decadeMap = new Map();
            for (const p of people) {
              const y = yearFromISO(p?.birth?.dateISO);
              if (y === null) continue;
              const d = Math.floor(y / 10) * 10;
              decadeMap.set(d, (decadeMap.get(d) || 0) + 1);
            }
            const peakDecadeEntry = Array.from(decadeMap.entries()).sort((a, b) => b[1] - a[1])[0] || null;
            const peakDecade = peakDecadeEntry ? `${peakDecadeEntry[0]}s` : "—";

            // Avg lifespan (1..110) with both dates
            const ages = people
              .map((p) => {
                const by = yearFromISO(p?.birth?.dateISO);
                const dy = yearFromISO(p?.death?.dateISO);
                if (by === null || dy === null) return null;
                const age = dy - by;
                if (age < 1 || age > 110) return null;
                return age;
              })
              .filter((a) => a !== null);
            const avgLife = ages.length ? Math.round(ages.reduce((a, b) => a + b, 0) / ages.length) : null;

            // Countries / states lists
            const countryMap = new Map();
            const stateMap = new Map();
            for (const p of people) {
              const place = p?.birth?.place;
              if (!place) continue;
              const c = getCountry(place);
              const s = getState(place);
              if (c) countryMap.set(c, (countryMap.get(c) || 0) + 1);
              if (s) stateMap.set(s, (stateMap.get(s) || 0) + 1);
            }
            const countries = topNByCount(countryMap, 5).map(([k]) => k).join(", ") || "—";
            const states = topNByCount(stateMap, 5).map(([k]) => k).join(", ") || "—";

            // Variant spellings (distance <= 2), scan all surnames in tree (deceased only)
            const variants = [];
            for (const [candidate, count] of surnameCounts.entries()) {
              if (candidate === surname) continue;
              if (!candidate) continue;
              if (Math.abs(candidate.length - surname.length) > 2) continue;
              if (levenshtein(candidate, surname) <= 2) {
                variants.push({ candidate, count });
              }
            }
            const variantText = variants.length
              ? variants
                  .sort((a, b) => b.count - a.count)
                  .slice(0, 8)
                  .map((v) => `${v.candidate} (${v.count})`)
                  .join(", ")
              : "—";

            // Birth decade breakdown (scale bar to max 20)
            const decadeSeries = Array.from(decadeMap.entries())
              .sort((a, b) => a[0] - b[0])
              .map(([d, births]) => ({ decade: `${d}s`, births }));
            const maxBirths = decadeSeries.reduce((m, d) => Math.max(m, d.births), 0) || 1;
            const decadeRows = decadeSeries.map((d) => {
              const len = Math.min(20, Math.round((d.births / maxBirths) * 20));
              return [d.decade, String(d.births), "█".repeat(len)];
            });

            // Geographic Journey narrative
            const earliestDecade = earliestYear !== null ? decadeLabel(earliestYear) : "";
            const topState = topNByCount(stateMap, 1)[0]?.[0] || "";
            const topStates = topNByCount(stateMap, 3).map(([k]) => k).filter(Boolean);
            const mostRecentState =
              mostRecentYear === null
                ? ""
                : (() => {
                    const recentPlaces = people
                      .filter((p) => yearFromISO(p?.birth?.dateISO) === mostRecentYear)
                      .map((p) => getState(p?.birth?.place || ""))
                      .filter(Boolean);
                    return recentPlaces[0] || topState || "";
                  })();
            const journey = (() => {
              const origin = topNByCount(countryMap, 1)[0]?.[0] || "unknown region";
              const spread = topStates.length ? topStates.join(", ") : "other regions";
              const mid = peakDecadeEntry ? `${peakDecadeEntry[0]}s` : "later decades";
              const midPlace = topState || "a common region";
              const recent = mostRecentState || midPlace || "a common region";
              const s = surname;
              return `The ${s} family appears earliest in ${origin} in the ${earliestDecade || "early records"}. By the ${mid}, the majority of ${s} births were recorded in ${midPlace || "a primary region"}. The family spread to ${spread} across subsequent generations, with the most recent records concentrated in ${recent}.`;
            })();

            // Notable individuals (up to 5)
            const oldest = people
              .map((p) => {
                const by = yearFromISO(p?.birth?.dateISO);
                const dy = yearFromISO(p?.death?.dateISO);
                if (by === null || dy === null) return null;
                const age = dy - by;
                if (age < 1 || age > 110) return null;
                return { p, by, dy, age };
              })
              .filter(Boolean)
              .sort((a, b) => b.age - a.age)[0]?.p;

            const earliestBorn = earliestPerson;

            const mostChildren = people
              .map((p) => ({ p, children: countChildrenAsParent(p, familiesById) }))
              .sort((a, b) => b.children - a.children)[0];

            const mostCited = people
              .map((p) => ({ p, citations: personSourceCitationCount(p) }))
              .sort((a, b) => b.citations - a.citations)[0];

            const tagged = people
              .map((p) => ({ p, tag: personHasNotableRawTags(p) }))
              .filter((x) => x.tag)[0]?.p;

            const picks = [];
            if (oldest) picks.push({ p: oldest, reason: "Oldest (age at death)" });
            if (earliestBorn && !picks.some((x) => x.p.id === earliestBorn.id)) {
              picks.push({ p: earliestBorn, reason: "Earliest born" });
            }
            if (mostChildren?.children > 0 && !picks.some((x) => x.p.id === mostChildren.p.id)) {
              picks.push({ p: mostChildren.p, reason: `${mostChildren.children} children` });
            }
            if (mostCited?.citations > 0 && !picks.some((x) => x.p.id === mostCited.p.id)) {
              picks.push({ p: mostCited.p, reason: `${mostCited.citations} source citations` });
            }
            if (tagged && !picks.some((x) => x.p.id === tagged.id)) {
              picks.push({ p: tagged, reason: `${personHasNotableRawTags(tagged)} record` });
            }
            const notable = picks.slice(0, 5);

            // Linked surnames (marriage connections)
            const marriedIntoItems = [];
            for (const p of people) {
              const fams = Array.isArray(p?.familiesAsSpouse) ? p.familiesAsSpouse : [];
              for (const fid of fams) {
                const fam = familiesById.get(fid);
                if (!fam) continue;
                const spouseId = fam.husband === p.id ? fam.wife : fam.husband;
                if (!spouseId) continue;
                const spouse = personById.get(spouseId);
                if (!spouse) continue;
                const spouseSurname = normalizeSurname(spouse?.name?.surname);
                if (!spouseSurname || spouseSurname === surname) continue;
                const exYear = yearFromISO(spouse?.birth?.dateISO);
                marriedIntoItems.push({
                  key: spouseSurname,
                  example: `${displayName(spouse)}${exYear !== null ? ` b.${exYear}` : ""}`,
                });
              }
            }
            const marriedInto = topItemsWithExamples(marriedIntoItems, 10);

            // Research gaps
            const missingBirthDate = people.filter((p) => !p?.birth?.dateISO);
            const missingBirthPlace = people.filter((p) => !p?.birth?.place);
            const noSpouse = people.filter((p) => !Array.isArray(p?.familiesAsSpouse) || p.familiesAsSpouse.length === 0);
            const noParents = people.filter((p) => !Array.isArray(p?.familiesAsChild) || p.familiesAsChild.length === 0);

            const exampleOf = (arr) => {
              const p = arr.find(Boolean);
              if (!p) return "—";
              const y = yearFromISO(p?.birth?.dateISO);
              const approx = p?.birth?.date && !p?.birth?.dateISO ? "~" : "";
              return `${displayName(p)}${y !== null ? ` ${approx}${y}` : ""}`.trim();
            };

            const overviewRows = [
              ["Total Individuals", people.length.toLocaleString()],
              ["Males / Females", `${males} / ${females}`],
              [
                "Earliest Known",
                earliestPerson && earliestYear !== null
                  ? `${displayName(earliestPerson)}, born ${earliestYear}, ${earliestPerson?.birth?.place || "—"}`
                  : "—",
              ],
              [
                "Most Recent Born",
                recentPerson && mostRecentYear !== null ? `${displayName(recentPerson)}, born ${mostRecentYear}` : "—",
              ],
              ["Peak Generation", peakDecade],
              ["Avg Lifespan", avgLife !== null ? `${avgLife} years` : "—"],
              ["Countries of Origin", countries],
              ["US States Present", states],
              ["Variant Spellings", variantText],
            ];

            const blocks = [];
            if (idx > 0) blocks.push(new Paragraph({ pageBreakBefore: true }));

            blocks.push(heading2(`${surname} FAMILY`));
            blocks.push(makeOutlineRule());

            blocks.push(makeTable({
              header: ["Metric", "Value"],
              headerFill: "D5E8F0",
              headerTextColor: "000000",
              rows: overviewRows,
              columnWidths: [4680, 4680],
            }));

            if (decadeRows.length > 0) {
              blocks.push(heading2("Birth Decade Breakdown"));
              blocks.push(makeTable({
                header: ["Decade", "Births", "Spark bar"],
                rows: decadeRows,
                columnWidths: [2000, 1500, 5860],
              }));
            }

            blocks.push(heading2("Geographic Journey"));
            blocks.push(body(journey));

            blocks.push(heading2("Notable Individuals"));
            blocks.push(makeTable({
              header: ["Name", "Born", "Died", "Notable For"],
              rows: notable.length
                ? notable.map(({ p, reason }) => [
                    displayName(p),
                    yearFromISO(p?.birth?.dateISO) ?? "—",
                    yearFromISO(p?.death?.dateISO) ?? "—",
                    reason,
                  ])
                : [["—", "—", "—", "—"]],
              columnWidths: [3800, 1000, 1000, 3560],
            }));

            blocks.push(heading2("Linked Surnames (marriage connections)"));
            blocks.push(makeTable({
              header: ["Married Into", "Count", "Example"],
              rows: marriedInto.length
                ? marriedInto.map((m) => [m.key, String(m.count), m.example || "—"])
                : [["—", "0", "—"]],
              columnWidths: [3000, 1500, 4860],
            }));

            blocks.push(heading2("Research Gaps"));
            blocks.push(makeTable({
              header: ["Gap Type", "Count", "Example"],
              rows: [
                ["Missing birth date", String(missingBirthDate.length), exampleOf(missingBirthDate)],
                ["Missing birthplace", String(missingBirthPlace.length), exampleOf(missingBirthPlace)],
                ["No spouse recorded", String(noSpouse.length), exampleOf(noSpouse)],
                ["No parents recorded", String(noParents.length), exampleOf(noParents)],
              ],
              columnWidths: [3400, 1200, 4760],
            }));

            return blocks;
          }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outPath, buffer);

  console.log(`Report generated: reports/family-tree-report-${dateStr}.docx`);
  console.log(
    `Sections: 9 | Pages: ~${Math.max(2, Math.ceil((individuals.length + families.length) / 500))} | Individuals: ${individuals.length}`,
  );
}

generate().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
