#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import dotenv from 'dotenv';

import { getLatestConvertedJsonPath } from './_json-latest.js';
import { displayPersonName } from './_string.js';
import { getAccessToken } from './fs-auth.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

function getEnvironment() {
  const env = (process.env.FS_ENVIRONMENT || 'sandbox').toLowerCase();
  if (env !== 'sandbox' && env !== 'production') {
    throw new Error(`FS_ENVIRONMENT must be sandbox|production (got ${process.env.FS_ENVIRONMENT || ''})`);
  }
  return env;
}

function getApiBaseUrl(environment) {
  // Note: FamilySearch "integration" and "production" API base URLs differ from ident*.
  return environment === 'production'
    ? 'https://api.familysearch.org'
    : 'https://integration.familysearch.org';
}

function parseArgs(argv) {
  const args = { resume: false, person: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--resume') args.resume = true;
    else if (a === '--person') args.person = argv[i + 1] || null, i++;
  }
  return args;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function yearFromISO(dateISO) {
  if (!dateISO || typeof dateISO !== 'string') return null;
  const m = dateISO.match(/^(\d{4})-/);
  if (!m) return null;
  const year = Number(m[1]);
  return Number.isFinite(year) ? year : null;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstWord(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean)[0] || '';
}

function placeParts(place) {
  return String(place || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
}

function countryFromPlace(place) {
  const parts = placeParts(place);
  return parts.length > 0 ? parts[parts.length - 1].toLowerCase() : '';
}

function stateFromPlace(place) {
  const parts = placeParts(place);
  if (parts.length < 2) return '';
  return parts[parts.length - 2].toLowerCase();
}

function buildTreeSearchUrl({ baseUrl, given, surname, birthYear, birthPlace, deathYear }) {
  const url = new URL(`${baseUrl}/platform/tree/search`);
  if (given) url.searchParams.set('q.givenName', given);
  if (surname) url.searchParams.set('q.surname', surname);
  if (birthYear) url.searchParams.set('q.birthLikeDate', String(birthYear));
  if (birthPlace) url.searchParams.set('q.birthLikePlace', birthPlace);
  if (deathYear) url.searchParams.set('q.deathLikeDate', String(deathYear));
  url.searchParams.set('count', '10');
  return url.toString();
}

function extractFacts(person) {
  const facts = Array.isArray(person?.facts) ? person.facts : [];
  let birth = null;
  let death = null;

  for (const fact of facts) {
    const type = String(fact?.type || '').toLowerCase();
    if (type.endsWith('/birth') && !birth) birth = fact;
    if (type.endsWith('/death') && !death) death = fact;
  }

  const birthYear = yearFromISO(birth?.date?.original);
  const deathYear = yearFromISO(death?.date?.original);

  return {
    birth: {
      original: birth?.date?.original || null,
      year: birthYear,
      place: birth?.place?.original || null
    },
    death: {
      original: death?.date?.original || null,
      year: deathYear,
      place: death?.place?.original || null
    }
  };
}

function extractEntryPersons(entry) {
  const content = entry?.content || entry?.content?.gedcomx || null;
  const gx = content?.gedcomx || content;
  const persons = Array.isArray(gx?.persons) ? gx.persons : [];
  return persons;
}

function extractDisplayName(person) {
  const names = Array.isArray(person?.names) ? person.names : [];
  const nf = names[0]?.nameForms?.[0];
  return nf?.fullText || null;
}

function extractPersonId(person) {
  // GedcomX person.id is often a URI; the last segment is the FS person id.
  const id = String(person?.id || '');
  if (!id) return null;
  const last = id.split('/').filter(Boolean).pop();
  return last || null;
}

function scoreMatch({ individual, candidate }) {
  let score = 0;

  const given = normalizeName(firstWord(individual?.name?.given));
  const surname = normalizeName(individual?.name?.surname);
  const candName = normalizeName(candidate.name || '');

  const candGiven = normalizeName(firstWord(candidate.given || candidate.name || ''));
  const candSurname = normalizeName(candidate.surname || '');

  if (surname && candSurname && surname === candSurname) score += 30;
  else if (surname && candName.includes(surname)) score += 15;

  if (given && candGiven && given === candGiven) score += 20;
  else if (given && candName.includes(given)) score += 10;

  const birthYear = yearFromISO(individual?.birth?.dateISO);
  if (birthYear !== null && candidate.birthYear !== null) {
    const diff = Math.abs(birthYear - candidate.birthYear);
    if (diff === 0) score += 20;
    else if (diff <= 2) score += 20;
  }

  const deathYear = yearFromISO(individual?.death?.dateISO);
  if (deathYear !== null && candidate.deathYear !== null) {
    const diff = Math.abs(deathYear - candidate.deathYear);
    if (diff <= 2) score += 10;
  }

  const birthPlace = individual?.birth?.place || '';
  const candBirthPlace = candidate.birthPlace || '';
  const c1 = countryFromPlace(birthPlace);
  const c2 = countryFromPlace(candBirthPlace);
  if (c1 && c2 && c1 === c2) score += 10;

  const s1 = stateFromPlace(birthPlace);
  const s2 = stateFromPlace(candBirthPlace);
  if (s1 && s2 && s1 === s2) score += 10;

  return score;
}

async function searchTreePerson({ token, environment, individual }) {
  const baseUrl = getApiBaseUrl(environment);

  const given = individual?.name?.given || '';
  const surname = individual?.name?.surname || '';

  const birthYear = yearFromISO(individual?.birth?.dateISO);
  const deathYear = yearFromISO(individual?.death?.dateISO);
  const birthPlace = individual?.birth?.place || '';

  const url = buildTreeSearchUrl({
    baseUrl,
    given,
    surname,
    birthYear,
    birthPlace,
    deathYear
  });

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/x-gedcomx-atom+json'
    }
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`FamilySearch search failed (${res.status}): ${text.slice(0, 500)}`);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`FamilySearch search response was not JSON: ${text.slice(0, 200)}`);
  }

  const entries = Array.isArray(json?.entries) ? json.entries : Array.isArray(json?.feed?.entries) ? json.feed.entries : [];
  const candidates = [];

  for (const entry of entries) {
    const persons = extractEntryPersons(entry);
    for (const person of persons) {
      const fsPersonId = extractPersonId(person);
      const name = extractDisplayName(person);
      const facts = extractFacts(person);

      // Attempt to derive given/surname from the display name.
      let candGiven = '';
      let candSurname = '';
      if (name) {
        const parts = name.split(' ').filter(Boolean);
        candGiven = parts[0] || '';
        candSurname = parts.length > 1 ? parts[parts.length - 1] : '';
      }

      candidates.push({
        fsPersonId,
        name,
        given: candGiven,
        surname: candSurname,
        birthYear: facts.birth.year,
        birthPlace: facts.birth.place,
        deathYear: facts.death.year
      });
    }
  }

  // De-dupe by fsPersonId
  const seen = new Set();
  const deduped = [];
  for (const c of candidates) {
    const key = c.fsPersonId || `${c.name}|${c.birthYear || ''}|${c.birthPlace || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(c);
  }

  return deduped;
}

function mapResult({ individual, best }) {
  const id = individual.id;
  const matchedName = best?.name || null;
  const matchedBirth = best?.birthYear ? String(best.birthYear) : null;
  const fsPersonId = best?.fsPersonId || null;
  const fsProfileUrl = fsPersonId ? `https://familysearch.org/tree/person/${fsPersonId}` : null;

  return {
    personId: id,
    personName: displayPersonName(individual),
    fsPersonId,
    confidence: best?.confidence || 'none',
    score: best?.score || 0,
    matchedName,
    matchedBirth,
    fsProfileUrl,
    status: best?.status || 'no_match',
    reviewedByHuman: false
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const environment = getEnvironment();
  const token = await getAccessToken();

  const latestJsonPath = getLatestConvertedJsonPath();
  const data = JSON.parse(fs.readFileSync(latestJsonPath, 'utf-8'));
  const individuals = Array.isArray(data.individuals) ? data.individuals : [];

  const mappingPath = path.join(projectRoot, 'data', 'fs-mapping.json');
  const existing = readJson(mappingPath, {
    generatedAt: null,
    totalSearched: 0,
    matched: 0,
    possibleMatch: 0,
    noMatch: 0,
    mappings: {}
  });
  existing.mappings = existing.mappings && typeof existing.mappings === 'object' ? existing.mappings : {};

  const toSearch = args.person
    ? individuals.filter(p => p.id === args.person)
    : individuals;

  let totalSearched = 0;
  let matched = 0;
  let possibleMatch = 0;
  let noMatch = 0;

  const start = Date.now();

  for (const person of toSearch) {
    if (!person?.id) continue;
    if (args.resume && existing.mappings[person.id]?.status === 'matched') continue;

    if (person.living === true) {
      console.log(`Skipping living individual ${person.id} — will not send to FamilySearch`);
      continue;
    }

    totalSearched++;
    process.stdout.write(`[${totalSearched}/${toSearch.length}] Searching ${person.id} ${displayPersonName(person)}... `);

    let candidates = [];
    try {
      candidates = await searchTreePerson({ token, environment, individual: person });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`error (${msg})`);
      existing.mappings[person.id] = mapResult({ individual: person, best: { status: 'error', confidence: 'none', score: 0 } });
      // rate limit
      await sleep(1000);
      continue;
    }

    const scored = candidates
      .map(c => ({
        ...c,
        score: scoreMatch({
          individual: person,
          candidate: {
            name: c.name,
            given: c.given,
            surname: c.surname,
            birthYear: c.birthYear,
            birthPlace: c.birthPlace,
            deathYear: c.deathYear
          }
        })
      }))
      .sort((a, b) => b.score - a.score);

    const top = scored[0] || null;

    let status = 'no_match';
    let confidence = 'none';
    let score = 0;

    if (top) {
      score = top.score;
      if (score >= 60) {
        status = 'matched';
        confidence = 'high';
        matched++;
      } else if (score >= 30) {
        status = 'possible_match';
        confidence = 'medium';
        possibleMatch++;
      } else {
        status = 'no_match';
        confidence = 'none';
        noMatch++;
      }
    } else {
      noMatch++;
    }

    existing.mappings[person.id] = mapResult({
      individual: person,
      best: top
        ? { ...top, status, confidence, score: top.score }
        : { status, confidence, score: 0 }
    });

    console.log(`${status} (score ${score})`);

    // Persist incrementally for resume safety
    existing.generatedAt = new Date().toISOString();
    existing.totalSearched = (existing.totalSearched || 0) + 1;
    // Recompute totals from current run + previous counts is ambiguous; keep current run tallies in top-level fields.
    // We'll set the counts for this file based on computed values below after loop as well.
    writeJsonAtomic(mappingPath, existing);

    // Rate limit: 1 request/second
    await sleep(1000);
  }

  // Finalize counters from the mappings (deterministic)
  const mappings = existing.mappings || {};
  let m = 0;
  let pm = 0;
  let nm = 0;
  for (const v of Object.values(mappings)) {
    if (v?.status === 'matched') m++;
    else if (v?.status === 'possible_match') pm++;
    else if (v?.status === 'no_match') nm++;
  }

  existing.generatedAt = new Date().toISOString();
  existing.totalSearched = Object.keys(mappings).length;
  existing.matched = m;
  existing.possibleMatch = pm;
  existing.noMatch = nm;

  writeJsonAtomic(mappingPath, existing);

  const elapsedSec = ((Date.now() - start) / 1000).toFixed(1);
  console.log('\nFamilySearch matching complete');
  console.log(`  Source: ${path.relative(projectRoot, latestJsonPath)}`);
  console.log(`  Environment: ${environment}`);
  console.log(`  Mappings: ${existing.totalSearched}`);
  console.log(`  Matched: ${existing.matched}`);
  console.log(`  Possible match: ${existing.possibleMatch}`);
  console.log(`  No match: ${existing.noMatch}`);
  console.log(`  Output: ${path.relative(projectRoot, mappingPath)}`);
  console.log(`  Elapsed: ${elapsedSec}s`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
