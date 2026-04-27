#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { fileURLToPath } from 'url';

import { displayPersonName, gedPointerToId, slugify } from './_string.js';
import { getLatestConvertedJsonPath } from './_json-latest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const TYPE_TO_BUCKET = {
  photos: 'media'
};

function usage() {
  console.error('Usage: node scripts/add-document.js --person @I42@ --file path/to/file.jpg --type census --year 1880');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function generateDocId() {
  return `doc-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function parsePlaceComponents(place) {
  const parts = String(place || '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return { city: '', county: '', state: '', country: '' };
  }

  // Common GEDCOM: "City, County, State, Country"
  const [city = '', county = '', state = '', country = ''] = parts;
  return { city, county, state, country };
}

function getDocumentsRoot() {
  return path.join(projectRoot, 'documents');
}

function computePersonFolder(person, personPointer) {
  const id = gedPointerToId(personPointer) || 'unknown';
  const surnameSlug = slugify(person?.name?.surname) || 'unknown';
  const givenFirst = (person?.name?.given || '').trim().split(/\s+/).filter(Boolean)[0] || '';
  const givenSlug = slugify(givenFirst) || 'unknown';
  return path.join(getDocumentsRoot(), 'by-person', `${id}-${surnameSlug}-${givenSlug}`);
}

function ensureIndexesExist() {
  const now = new Date().toISOString();
  const docsRoot = getDocumentsRoot();
  const byTypeRoot = path.join(docsRoot, 'by-type');
  fs.mkdirSync(byTypeRoot, { recursive: true });

  const masterIndexPath = path.join(docsRoot, 'index.json');
  if (!fs.existsSync(masterIndexPath)) {
    writeJsonAtomic(masterIndexPath, { generatedAt: now, totalDocuments: 0, documents: [] });
  }
}

function upsertByTypeIndex(type, entry) {
  const byTypePath = path.join(getDocumentsRoot(), 'by-type', `${type}.json`);
  const now = new Date().toISOString();
  const idx = readJson(byTypePath, { generatedAt: now, type, totalDocuments: 0, documents: [] });
  idx.generatedAt = now;
  idx.documents = Array.isArray(idx.documents) ? idx.documents : [];

  if (!idx.documents.some(d => d.id === entry.id)) {
    idx.documents.push(entry);
  }
  idx.totalDocuments = idx.documents.length;
  writeJsonAtomic(byTypePath, idx);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const personId = args.person;
  const srcFile = args.file;
  const type = args.type;

  if (!personId || !srcFile || !type) {
    usage();
    process.exit(1);
  }

  const srcPath = path.resolve(process.cwd(), srcFile);
  if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
    console.error(`Error: file not found: ${srcPath}`);
    process.exit(1);
  }

  const yearArg = args.year ? Number(args.year) : null;
  const rl = readline.createInterface({ input, output });

  try {
    const latestJsonPath = getLatestConvertedJsonPath();
    const tree = JSON.parse(fs.readFileSync(latestJsonPath, 'utf-8'));
    const people = Array.isArray(tree.individuals) ? tree.individuals : [];
    const person = people.find(p => p.id === personId);
    if (!person) {
      console.error(`Error: person not found in ${path.relative(projectRoot, latestJsonPath)}: ${personId}`);
      process.exit(1);
    }

    const personName = displayPersonName(person);
    const personFolder = computePersonFolder(person, personId);
    const bucket = TYPE_TO_BUCKET[type] || 'records';
    const targetDir = path.join(personFolder, bucket);
    fs.mkdirSync(targetDir, { recursive: true });

    const filenameDefault = path.basename(srcPath);
    const filename = (await rl.question(`Filename to store [${filenameDefault}]: `)).trim() || filenameDefault;
    const targetPath = path.join(targetDir, filename);

    if (fs.existsSync(targetPath)) {
      console.warn(`Skip: file already exists at target path: ${path.relative(projectRoot, targetPath)}`);
      return;
    }

    // Prompt for missing metadata
    const subtype = (await rl.question('Subtype (optional): ')).trim();
    const year = Number.isFinite(yearArg) ? yearArg : Number((await rl.question('Year (optional): ')).trim() || '');
    const dateRaw = (await rl.question('Date (raw, optional): ')).trim();
    const dateISO = (await rl.question('Date ISO (optional, e.g. 1880-06-01): ')).trim();
    const dateQualifier = (await rl.question('Date qualifier (optional, e.g. ABT/BEF/AFT/BET): ')).trim();
    const place = (await rl.question('Place (optional): ')).trim();
    const source = (await rl.question('Source (optional, e.g. FamilySearch/Ancestry): ')).trim();
    const sourceUrl = (await rl.question('Source URL (optional): ')).trim();
    const sourceId = (await rl.question('Source ID (optional): ')).trim();
    const relatedPersonIdsRaw = (await rl.question('Related person IDs (comma-separated, optional): ')).trim();
    const tagsRaw = (await rl.question('Tags (comma-separated, optional): ')).trim();

    // Copy file (idempotent via exists check above)
    fs.copyFileSync(srcPath, targetPath, fs.constants.COPYFILE_EXCL);

    const entry = {
      id: generateDocId(),
      filename,
      localPath: path.relative(projectRoot, targetPath),
      type,
      subtype,
      year: Number.isFinite(year) ? year : null,
      dateRaw,
      dateISO: dateISO || null,
      dateQualifier: dateQualifier || null,
      place,
      placeComponents: parsePlaceComponents(place),
      source,
      sourceUrl,
      sourceId,
      relatedPersonIds: relatedPersonIdsRaw ? relatedPersonIdsRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
      tags: tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
      transcription: '',
      aiSummary: '',
      verified: false,
      addedAt: new Date().toISOString(),
      addedBy: 'manual'
    };

    // Update per-person metadata.json
    const metadataPath = path.join(personFolder, 'metadata.json');
    const metadata = readJson(metadataPath, { personId, personName, documents: [] });
    metadata.personId = personId;
    metadata.personName = personName;
    metadata.documents = Array.isArray(metadata.documents) ? metadata.documents : [];
    metadata.documents.push(entry);
    writeJsonAtomic(metadataPath, metadata);

    // Update master index.json
    ensureIndexesExist();
    const masterIndexPath = path.join(getDocumentsRoot(), 'index.json');
    const master = readJson(masterIndexPath, { generatedAt: new Date().toISOString(), totalDocuments: 0, documents: [] });
    master.generatedAt = new Date().toISOString();
    master.documents = Array.isArray(master.documents) ? master.documents : [];
    master.documents.push({ ...entry, personId, personName });
    master.totalDocuments = master.documents.length;
    writeJsonAtomic(masterIndexPath, master);

    // Update by-type index
    upsertByTypeIndex(type, { ...entry, personId, personName });

    console.log(`Added document for ${personName} (${personId})`);
    console.log(`  Stored at: ${path.relative(projectRoot, targetPath)}`);
    console.log(`  Document id: ${entry.id}`);
  } finally {
    rl.close();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

