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

function hashString(value) {
  // Deterministic hash for stable template selection (no randomness).
  const s = String(value || "");
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i); // djb2 xor
  return Math.abs(h);
}

function templateNarrative(person, context) {
  const name = cleanName(String(person?.name?.full || "")).trim() || "This person";
  const first = firstWord(cleanName(person?.name?.given || name)) || "They";
  const { subject } = pronouns(person?.sex);
  const birthDate = person?.birth?.date || "";
  const birthPlace = person?.birth?.place || "";
  const deathYear = yearFromISO(person?.death?.dateISO);
  const deathPlace = person?.death?.place || "";
  const birthYear = yearFromISO(person?.birth?.dateISO);
  const surname = cleanName(String(person?.name?.surname || "")).replace(/\s+/g, " ").trim();
  const hasSpouseLink = Array.isArray(person?.familiesAsSpouse) && person.familiesAsSpouse.length > 0;

  const topEvent = context?.events?.[0]?.event || "";
  const topFact = context?.events?.[0]?.funFact || "";

  const bornClause = (() => {
    if (birthDate || birthPlace) {
      return `on ${birthDate || "an unknown day"}${birthPlace ? ` in ${birthPlace}` : ""}`;
    }
    if (birthYear) return `around ${birthYear}`;
    return "at an unknown time";
  })();

  const diedClause = (() => {
    if (!deathYear && !deathPlace) return "";
    const where = deathPlace ? ` in ${deathPlace}` : "";
    return `${deathYear ? ` in ${deathYear}` : ""}${where}`.trim();
  })();

  const eraLine = topEvent ? `${first} lived during the era of ${topEvent}.` : "";
  const factLine = topFact ? topFact : "";
  const familyLine = hasSpouseLink ? "Family records show at least one marriage connection." : "Family records suggest connections across generations.";

  const closings = [
    (age) => `${subject} passed away${diedClause ? ` ${diedClause}` : ""}${age ? ` at about age ${age}` : ""}.`,
    (age) => `${subject} died${diedClause ? ` ${diedClause}` : ""}${age ? `, around age ${age}` : ""}.`,
    (age) => `${subject}'s life ended${diedClause ? ` ${diedClause}` : ""}${age ? ` at roughly ${age}` : ""}.`,
    (age) => `${subject} lived a life shaped by their time${age ? `, reaching about ${age} years` : ""}.`,
  ];

  const age = (() => {
    const by = birthYear;
    const dy = deathYear;
    if (by === null || dy === null) return null;
    const a = dy - by;
    return a > 0 && a <= 110 ? a : null;
  })();

  const templates = [
    () =>
      [
        birthPlace || birthDate ? `Born ${bornClause}, ${name} begins our story in the family record.` : `${name} appears in the family record.`,
        eraLine,
        familyLine,
        factLine,
        (deathYear || deathPlace) && closings[0](age),
      ].filter(Boolean).join(" "),
    () =>
      [
        `${name} came into the world ${bornClause}.`,
        hasSpouseLink ? `${first} later appears in marriage records, marking a new chapter for the family.` : "",
        eraLine,
        factLine,
        (deathYear || deathPlace) && closings[1](age),
      ].filter(Boolean).join(" "),
    () =>
      [
        surname ? `The ${surname} family welcomed ${first} ${bornClause}.` : `${name} was born ${bornClause}.`,
        eraLine,
        familyLine,
        (deathYear || deathPlace) && closings[2](age),
      ].filter(Boolean).join(" "),
    () =>
      [
        birthPlace ? `Records show ${name} in ${birthPlace}${birthYear ? ` around ${birthYear}` : ""}.` : `${name} is recorded in the family tree.`,
        eraLine,
        factLine,
        hasSpouseLink ? "Their relationships connect them to other branches of the tree." : "",
        (deathYear || deathPlace) && closings[3](age),
      ].filter(Boolean).join(" "),
    () =>
      [
        `${name} was born ${bornClause}${birthYear ? ` (about ${birthYear})` : ""}.`,
        factLine,
        eraLine,
        familyLine,
        (deathYear || deathPlace) && closings[0](age),
      ].filter(Boolean).join(" "),
  ];

  const idx = hashString(person?.id) % templates.length;
  return templates[idx]();
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
    const text = templateNarrative(person, context);
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
    const text = templateNarrative(person, context);
    writeCachedNarrative(personId, text);
    return { text, source: "template" };
  }

  const ok = await checkOllamaConnectivity({ baseUrl, model });
  if (!ok) {
    console.log(`Generating narrative for: ${personNameForLog} (via template)`);
    const text = templateNarrative(person, context);
    writeCachedNarrative(personId, text);
    return { text, source: "template" };
  }

  const name = cleanName(String(person?.name?.full || "")).replace(/\s+/g, " ").trim();
  const first = firstWord(cleanName(person?.name?.given)) || firstWord(name);
  const birthDate = person?.birth?.date || "";
  const birthPlace = person?.birth?.place || "";
  const deathDate = person?.death?.date || "";
  const deathPlace = person?.death?.place || "";
  const events = (context?.events || []).slice(0, 2).map((e) => e.event).filter(Boolean);

  const prompt = [
    "Write a warm, engaging 2-3 paragraph biography for a family history book about",
    `${name || "this person"}, born ${birthDate || "unknown date"} in ${birthPlace || "unknown place"}, died ${deathDate || "unknown date"} in ${deathPlace || "unknown place"}.`,
    `Historical context of their era: ${events.length ? events.join("; ") : "N/A"}.`,
    "Write for a general audience including children. Use present tense for historical description.",
    "Be curious and humanizing, not clinical. Do not invent facts not provided.",
    "STRICT RULES:",
    "- Do NOT invent hobbies, interests, or preferences.",
    "- Do NOT mention specific music, books, or cultural preferences unless in the provided data.",
    "- Do NOT invent personality traits.",
    "- DO focus on: their historical era, their location, their family structure (from provided data), and what daily life would have realistically looked like for someone of their time and place.",
    "- If data is sparse, describe their era and place vividly rather than inventing personal details.",
    "- Write as a thoughtful historian, not a fiction writer.",
    "- Maximum 150 words.",
    "Do not use the word 'undoubtedly'.",
    first ? `Start by using their first name: ${first}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  try {
    console.log(`Generating narrative for: ${personNameForLog} (via Ollama)`);
    const res = await axios.post(
      `${baseUrl.replace(/\/$/, "")}/api/generate`,
      { model, prompt, stream: false },
      { timeout: 60_000 },
    );
    const text = String(res?.data?.response || "").trim();
    if (!text) throw new Error("Empty response");
    writeCachedNarrative(personId, text);
    return { text, source: "ollama" };
  } catch (error) {
    console.warn(`Ollama generate failed (${error?.message || String(error)}); falling back to templates.`);
    console.log(`Generating narrative for: ${personNameForLog} (via template)`);
    const text = templateNarrative(person, context);
    writeCachedNarrative(personId, text);
    return { text, source: "template" };
  }
}
