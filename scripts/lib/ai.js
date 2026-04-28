import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "../..");

let ollamaChecked = false;
let ollamaReachable = false;
let loggedFirstNarrative = false;

function cleanName(raw) {
  if (!raw) return "";
  // Remove GEDCOM surname slashes: /Smith/ or /SMITH/
  return String(raw).replace(/\s*\/[^/]*\/\s*/g, " ").replace(/\s+/g, " ").trim();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cachePathForPerson(personId) {
  const safe = String(personId || "unknown").replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(projectRoot, "data", "narrative-cache", `${safe}.txt`);
}

function readCachedNarrative(personId) {
  const p = cachePathForPerson(personId);
  if (!fs.existsSync(p)) return null;
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function writeCachedNarrative(personId, text) {
  const p = cachePathForPerson(personId);
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, text, "utf-8");
}

function firstWord(value) {
  return String(value || "").trim().split(/\s+/).filter(Boolean)[0] || "";
}

function pronouns(sex) {
  if (sex === "M") return { subject: "He", object: "him", possessive: "his" };
  if (sex === "F") return { subject: "She", object: "her", possessive: "her" };
  return { subject: "They", object: "them", possessive: "their" };
}

function yearFromISO(dateISO) {
  if (!dateISO || typeof dateISO !== "string") return null;
  const m = dateISO.match(/^(\d{4})-/);
  if (!m) return null;
  const year = Number(m[1]);
  return Number.isFinite(year) ? year : null;
}

function safeTagEntries(rawTags, tag) {
  const value = rawTags?.[tag];
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function tagValue(entry) {
  if (entry === null || entry === undefined) return "";
  if (typeof entry === "string") return entry.trim();
  if (typeof entry?.value === "string") return entry.value.trim();
  return "";
}

function tagTreeValue(entry, treeTag) {
  const tree = Array.isArray(entry?.tree) ? entry.tree : [];
  const hit = tree.find((node) => String(node?.tag || "").toUpperCase() === String(treeTag || "").toUpperCase());
  return tagValue(hit);
}

function eventTypeLabel(tag) {
  const t = String(tag || "").toUpperCase();
  if (t === "MILI") return "Military";
  if (t === "NATU") return "Naturalization";
  if (t === "EMIG") return "Emigration";
  if (t === "IMMI") return "Immigration";
  if (t === "EDUC") return "Education";
  if (t === "EVEN") return "Event";
  return t;
}

function extractOccupation(person) {
  const entries = safeTagEntries(person?.rawTags || {}, "OCCU");
  if (!entries.length) return null;
  const first = entries[0];
  return tagValue(first) || tagTreeValue(first, "TYPE") || null;
}

function extractResidences(person) {
  const entries = safeTagEntries(person?.rawTags || {}, "RESI");
  const out = [];
  for (const entry of entries) {
    const date = tagTreeValue(entry, "DATE") || null;
    const place = tagTreeValue(entry, "PLAC") || null;
    if (date || place) out.push({ date, place });
  }
  return out;
}

function extractEvents(person) {
  const rawTags = person?.rawTags || {};
  const tags = ["MILI", "NATU", "EMIG", "IMMI", "EDUC", "EVEN"];
  const out = [];
  for (const tag of tags) {
    const entries = safeTagEntries(rawTags, tag);
    for (const entry of entries) {
      const date = tagTreeValue(entry, "DATE") || null;
      const place = tagTreeValue(entry, "PLAC") || null;
      const description = tagValue(entry) || tagTreeValue(entry, "TYPE") || null;
      out.push({
        type: eventTypeLabel(tag),
        date,
        place,
        description,
      });
    }
  }
  return out;
}

function buildNarrativeContext(person, context = {}) {
  const birthYear = yearFromISO(person?.birth?.dateISO);
  const deathYear = yearFromISO(person?.death?.dateISO);
  const ageAtDeath = birthYear && deathYear ? deathYear - birthYear : null;

  const stages = birthYear
    ? {
        birth: birthYear,
        childhood: birthYear + 10,
        comingOfAge: birthYear + 20,
        peakLife: birthYear + 35,
        lateLife: deathYear ? deathYear - 10 : birthYear + 60,
      }
    : null;

  const familiesById = context?.familiesById || null;
  const personById = context?.personById || null;
  const marriages = [];
  const childIds = new Set();
  const spouseFamilyIds = Array.isArray(person?.familiesAsSpouse) ? person.familiesAsSpouse : [];
  for (const fid of spouseFamilyIds) {
    const fam = familiesById?.get?.(fid);
    if (!fam) continue;
    const spouseId = fam.husband === person.id ? fam.wife : fam.husband;
    const spouse = spouseId ? personById?.get?.(spouseId) : null;
    const spouseName = spouse ? cleanName(spouse?.name?.full || "") : "";
    const marriageYear = yearFromISO(fam?.marriage?.dateISO);
    const marriagePlace = fam?.marriage?.place || "";
    marriages.push(
      [spouseName || "Unknown spouse", marriageYear ? `${marriageYear}` : "", marriagePlace ? `in ${marriagePlace}` : ""]
        .filter(Boolean)
        .join(", "),
    );
    const kids = Array.isArray(fam?.children) ? fam.children : [];
    for (const childId of kids) {
      if (childId) childIds.add(childId);
    }
  }
  const childrenNames = [];
  for (const childId of childIds) {
    const child = personById?.get?.(childId);
    const first = firstWord(cleanName(child?.name?.given || child?.name?.full || ""));
    if (first) childrenNames.push(first);
  }
  const childrenCount = childIds.size;

  const knownFacts = {
    birthDate: person?.birth?.date || null,
    birthPlace: person?.birth?.place || null,
    deathDate: person?.death?.date || null,
    deathPlace: person?.death?.place || null,
    ageAtDeath,
    sex: person?.sex || null,
    marriages,
    childrenCount,
    childrenNames: Array.from(new Set(childrenNames)).slice(0, 10),
    occupation: extractOccupation(person),
    residences: extractResidences(person),
    otherEvents: extractEvents(person),
  };

  return {
    stages,
    knownFacts,
    birthYear,
    deathYear,
    contextAtBirth: context?.lifeStageContext?.atBirth || "",
    contextAtChildhood: context?.lifeStageContext?.atChildhood || "",
    contextAtAdulthood: context?.lifeStageContext?.atAdulthood || "",
    contextAtLateLife: context?.lifeStageContext?.atLateLife || "",
  };
}

function formatEventLine(event) {
  const text = sanitizeNarrativeContextText(String(event || "").trim());
  return text || "No specific context recorded.";
}

function sanitizeNarrativeContextText(text) {
  let out = String(text || "");
  // Keep statistical context as background only; do not surface these directly in personal narratives.
  out = out
    .replace(/[^.]*life expectancy[^.]*\.?/gi, " ")
    .replace(/[^.]*literacy[^.]*%[^.]*\.?/gi, " ")
    .replace(/[^.]*climate change[^.]*\.?/gi, " ");
  return out.replace(/\s+/g, " ").trim();
}

function formatRecordedEvents(otherEvents) {
  if (!Array.isArray(otherEvents) || otherEvents.length === 0) return "No additional events recorded";
  return otherEvents
    .slice(0, 8)
    .map((e) =>
      [e?.type || "Event", e?.date || "", e?.place ? `in ${e.place}` : "", e?.description || ""]
        .filter(Boolean)
        .join(" - "),
    )
    .join("\n  - ");
}

function formatResidences(residences) {
  if (!Array.isArray(residences) || residences.length === 0) return "";
  return residences
    .slice(0, 6)
    .map((r) => [r?.date || "", r?.place || ""].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");
}

function truncateToWords(text, maxWords = 120) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= maxWords) return words.join(" ");
  return `${words.slice(0, maxWords).join(" ")}…`;
}

function templateNarrative(person, context) {
  const name = cleanName(String(person?.name?.full || "")).trim() || "This person";
  const facts = buildNarrativeContext(person, context);
  const known = facts.knownFacts;
  const lines = [];
  if (known.birthDate || known.birthPlace) {
    lines.push(
      `${name} was born${known.birthDate ? ` on ${known.birthDate}` : ""}${known.birthPlace ? ` in ${known.birthPlace}` : ""}.`,
    );
  } else if (facts.birthYear) {
    lines.push(`${name} was born around ${facts.birthYear}.`);
  }
  const birthCtx = formatEventLine(facts.contextAtBirth);
  if (birthCtx && birthCtx !== "No specific context recorded.") lines.push(`At the time of birth: ${birthCtx}.`);
  if (known.marriages.length) lines.push(`Marriage records: ${known.marriages.join("; ")}.`);
  if (known.childrenCount) {
    lines.push(
      `Children: ${known.childrenCount}${known.childrenNames.length ? ` (${known.childrenNames.join(", ")})` : ""}.`,
    );
  }
  if (known.occupation) lines.push(`Recorded occupation: ${known.occupation}.`);
  if (known.deathDate || known.deathPlace) {
    lines.push(
      `${name} passed away${known.deathDate ? ` ${known.deathDate}` : ""}${known.deathPlace ? ` in ${known.deathPlace}` : ""}.`,
    );
  }
  return lines.join(" ");
}

async function checkOllamaConnectivity({ baseUrl, model }) {
  if (ollamaChecked) return ollamaReachable;
  ollamaChecked = true;
  try {
    await axios.get(`${baseUrl.replace(/\/$/, "")}/api/tags`, { timeout: 5_000 });
    ollamaReachable = true;
    console.log(`Ollama connected: ${model}`);
    return true;
  } catch (error) {
    console.warn(`Ollama unreachable at ${baseUrl} (${error?.message || String(error)}); falling back to templates.`);
    ollamaReachable = false;
    return false;
  }
}

export async function getNarrative(person, context, options) {
  const personId = person?.id || "unknown";
  const refresh = Boolean(options?.refresh);
  const noAi = Boolean(options?.noAi);
  const personNameForLog = cleanName(person?.name?.full) || personId;
  const maxWords = Number.isFinite(Number(options?.maxWords)) ? Math.max(40, Number(options.maxWords)) : 120;

  // --no-ai mode must never call Ollama and must not touch the narrative cache.
  // This keeps "dry" or privacy-sensitive runs from writing any derived text to disk.
  if (noAi) {
    if (!loggedFirstNarrative) {
      loggedFirstNarrative = true;
      const model = process.env.OLLAMA_MODEL || "";
      const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
      console.log(`AI config: model=${model || "(unset)"} base=${baseUrl} noAi=${noAi}`);
    }
    console.log(`Generating narrative for: ${personNameForLog} (via template)`);
    const text = truncateToWords(templateNarrative(person, context), maxWords);
    return { text, source: "template" };
  }

  if (!refresh) {
    const cached = readCachedNarrative(personId);
    if (cached) {
      if (!loggedFirstNarrative) {
        loggedFirstNarrative = true;
        const model = process.env.OLLAMA_MODEL || "";
        const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
        console.log(`AI config: model=${model || "(unset)"} base=${baseUrl} noAi=${noAi}`);
      }
      console.log(`Generating narrative for: ${personNameForLog} (via template)`);
      return { text: cached, source: "cache" };
    }
  }

  const model = process.env.OLLAMA_MODEL || "";
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  if (!loggedFirstNarrative) {
    loggedFirstNarrative = true;
    console.log(`AI config: model=${model || "(unset)"} base=${baseUrl} noAi=${noAi}`);
  }

  if (!model) {
    console.log(`Generating narrative for: ${personNameForLog} (via template)`);
    const text = truncateToWords(templateNarrative(person, context), maxWords);
    writeCachedNarrative(personId, text);
    return { text, source: "template" };
  }

  const ok = await checkOllamaConnectivity({ baseUrl, model });
  if (!ok) {
    console.log(`Generating narrative for: ${personNameForLog} (via template)`);
    const text = truncateToWords(templateNarrative(person, context), maxWords);
    writeCachedNarrative(personId, text);
    return { text, source: "template" };
  }

  const name = cleanName(String(person?.name?.full || "")).replace(/\s+/g, " ").trim();
  const facts = buildNarrativeContext(person, context);
  const known = facts.knownFacts;
  const prompt = `
You are writing a brief biography for a printed family history book. Write ONLY from the facts provided. Do not invent any personal details, preferences, hobbies, or personality traits.
If a fact is not listed below, do not include it.

PERSON:
  Name: ${name || "Unknown"}
  Born: ${known.birthDate || "Unknown"}${known.birthPlace ? ` in ${known.birthPlace}` : ""}
  Died: ${known.deathDate || "Unknown"}${known.deathPlace ? ` in ${known.deathPlace}` : ""}
  ${known.ageAtDeath ? `Age at death: ${known.ageAtDeath}` : ""}
  Sex: ${known.sex || "Unknown"}
  ${known.occupation ? `Occupation: ${known.occupation}` : ""}

FAMILY:
  ${known.marriages.length ? `Married: ${known.marriages.join("; ")}` : "No marriage records found"}
  ${known.childrenCount ? `Children: ${known.childrenCount}${known.childrenNames.length ? ` (${known.childrenNames.join(", ")})` : ""}` : "Children: none recorded"}

RECORDED LIFE EVENTS:
  ${formatRecordedEvents(known.otherEvents)}
  ${known.residences.length ? `Lived in: ${formatResidences(known.residences)}` : ""}

HISTORICAL CONTEXT (what was happening in their world):
  At birth (${facts.stages?.birth ?? "unknown"}): ${formatEventLine(facts.contextAtBirth)}
  In childhood (~${facts.stages?.childhood ?? "unknown"}): ${formatEventLine(facts.contextAtChildhood)}
  In early adulthood (~${facts.stages?.comingOfAge ?? "unknown"}): ${formatEventLine(facts.contextAtAdulthood)}
  In later life (~${facts.stages?.lateLife ?? "unknown"}): ${formatEventLine(facts.contextAtLateLife)}

WRITE:
  Paragraph 1 (2-3 sentences): Birth, origin, the world they were born into.
  Paragraph 2 (2-3 sentences): What shaped their coming-of-age years, grounded in the context above.
  Paragraph 3 (2-4 sentences): Adult life using ONLY family and life-event facts above.
  Final sentence: obituary-style close.

RULES:
  - Paragraph 1: who this person was — birth, family origin, parents if known; include at most ONE short sentence of historical context.
  - Paragraph 2: actual life facts only — marriage, children, occupation, residences. If sparse, say that briefly.
  - Final sentence: death and legacy in obituary style ("NAME passed away in [year/place], survived by [N] children" when known).
  - Do not repeat historical context beyond one sentence.
  - Do NOT mention life expectancy statistics.
  - Do NOT quote literacy rate percentages.
  - Do NOT mention climate change.
  - OWID-style statistics are background-only; use them to inform era tone but do not cite them as facts.
  - Never invent hobbies, interests, or personality.
  - Always write in THIRD PERSON (he/she/they).
  - Never use "you" or "your".
  - Never use phrases like "known for", "loved by all", "had a passion for", "enjoyed", "was fond of" unless sourced from data.
  - Maximum ${maxWords} words total.
  - Write in past tense, warm but factual tone.
  - If data is sparse, write shorter and do not pad with fiction.
`.trim();

  try {
    console.log(`Generating narrative for: ${personNameForLog} (via Ollama)`);
    const res = await axios.post(
      `${baseUrl.replace(/\/$/, "")}/api/generate`,
      { model, prompt, stream: false },
      { timeout: 60_000 },
    );
    const text = truncateToWords(String(res?.data?.response || "").trim(), maxWords);
    if (!text) throw new Error("Empty response");
    writeCachedNarrative(personId, text);
    return { text, source: "ollama" };
  } catch (error) {
    console.warn(`Ollama generate failed (${error?.message || String(error)}); falling back to templates.`);
    console.log(`Generating narrative for: ${personNameForLog} (via template)`);
    const text = truncateToWords(templateNarrative(person, context), maxWords);
    writeCachedNarrative(personId, text);
    return { text, source: "template" };
  }
}
