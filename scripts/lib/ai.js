import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "../..");

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

function templateNarrative(person, context) {
  const name = String(person?.name?.full || "").replace(/\s+/g, " ").trim() || "This person";
  const first = firstWord(person?.name?.given || name) || "They";
  const { subject } = pronouns(person?.sex);
  const birthDate = person?.birth?.date || "";
  const birthPlace = person?.birth?.place || "";
  const deathYear = yearFromISO(person?.death?.dateISO);
  const deathPlace = person?.death?.place || "";
  const birthYear = yearFromISO(person?.birth?.dateISO);

  const topEvent = context?.events?.[0]?.event || "";
  const topFact = context?.events?.[0]?.funFact || "";

  const parts = [];
  if (birthDate || birthPlace) {
    const born = `born${birthDate ? ` on ${birthDate}` : ""}${birthPlace ? ` in ${birthPlace}` : ""}`;
    parts.push(`${name} was ${born}.`);
  } else if (birthYear) {
    parts.push(`${name} was born around ${birthYear}.`);
  } else {
    parts.push(`${name} appears in the family record, though many details are still waiting to be discovered.`);
  }

  if (topEvent) {
    parts.push(`${first} lived during a time of ${topEvent}.`);
  }
  if (topFact) {
    parts.push(topFact);
  }

  if (deathYear || deathPlace) {
    parts.push(
      `${subject} passed away${deathYear ? ` in ${deathYear}` : ""}${deathPlace ? ` in ${deathPlace}` : ""}.`,
    );
  }

  return parts.join(" ");
}

export async function getNarrative(person, context, options) {
  const personId = person?.id || "unknown";
  const refresh = Boolean(options?.refresh);
  const noAi = Boolean(options?.noAi);

  if (!refresh) {
    const cached = readCachedNarrative(personId);
    if (cached) return { text: cached, source: "cache" };
  }

  if (noAi) {
    const text = templateNarrative(person, context);
    writeCachedNarrative(personId, text);
    return { text, source: "template" };
  }

  const model = process.env.OLLAMA_MODEL || "";
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  if (!model) {
    const text = templateNarrative(person, context);
    writeCachedNarrative(personId, text);
    return { text, source: "template" };
  }

  const name = String(person?.name?.full || "").replace(/\s+/g, " ").trim();
  const first = firstWord(person?.name?.given) || firstWord(name);
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
    "If data is sparse, focus on what their daily life might have looked like given their time and place.",
    "Keep it under 200 words. Do not use the word 'undoubtedly'.",
    first ? `Start by using their first name: ${first}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  try {
    const res = await axios.post(
      `${baseUrl.replace(/\/$/, "")}/api/generate`,
      { model, prompt, stream: false },
      { timeout: 60_000 },
    );
    const text = String(res?.data?.response || "").trim();
    if (!text) throw new Error("Empty response");
    writeCachedNarrative(personId, text);
    return { text, source: "ollama" };
  } catch {
    const text = templateNarrative(person, context);
    writeCachedNarrative(personId, text);
    return { text, source: "template" };
  }
}

