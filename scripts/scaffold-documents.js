#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getLatestConvertedJsonPath } from './_json-latest.js';
import { displayPersonName, gedPointerToId, slugify } from './_string.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const DOCUMENT_TYPES = [
  'census',
  'vital-records',
  'immigration',
  'military',
  'photos',
  'wills-probate',
  'land-records',
  'church-records',
  'other'
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonIfMissing(filePath, data) {
  if (fs.existsSync(filePath)) return false;
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return true;
}

async function scaffold() {
  const latestJsonPath = getLatestConvertedJsonPath();
  const raw = fs.readFileSync(latestJsonPath, 'utf-8');
  const data = JSON.parse(raw);

  const documentsRoot = path.join(projectRoot, 'documents');
  const byPersonRoot = path.join(documentsRoot, 'by-person');
  const byTypeRoot = path.join(documentsRoot, 'by-type');
  const unassignedRoot = path.join(documentsRoot, 'unassigned');

  ensureDir(byPersonRoot);
  ensureDir(byTypeRoot);
  ensureDir(unassignedRoot);

  // Master index
  const now = new Date().toISOString();
  writeJsonIfMissing(path.join(documentsRoot, 'index.json'), {
    generatedAt: now,
    totalDocuments: 0,
    documents: []
  });

  // Type indexes
  for (const type of DOCUMENT_TYPES) {
    writeJsonIfMissing(path.join(byTypeRoot, `${type}.json`), {
      generatedAt: now,
      type,
      totalDocuments: 0,
      documents: []
    });
  }

  const individuals = Array.isArray(data.individuals) ? data.individuals : [];
  let createdFolders = 0;

  for (const person of individuals) {
    const pointer = person?.id || '';
    const id = gedPointerToId(pointer) || 'unknown';
    const surnameSlug = slugify(person?.name?.surname) || 'unknown';
    const givenFirst = (person?.name?.given || '').trim().split(/\s+/).filter(Boolean)[0] || '';
    const givenSlug = slugify(givenFirst) || 'unknown';

    const personDirName = `${id}-${surnameSlug}-${givenSlug}`;
    const personDir = path.join(byPersonRoot, personDirName);

    const existed = fs.existsSync(personDir);
    ensureDir(personDir);
    ensureDir(path.join(personDir, 'media'));
    ensureDir(path.join(personDir, 'records'));
    ensureDir(path.join(personDir, 'transcriptions'));
    if (!existed) createdFolders++;

    const metadataPath = path.join(personDir, 'metadata.json');
    writeJsonIfMissing(metadataPath, {
      personId: pointer,
      personName: displayPersonName(person),
      documents: []
    });
  }

  console.log(`Scaffold complete.`);
  console.log(`  Source: ${path.relative(projectRoot, latestJsonPath)}`);
  console.log(`  Individuals: ${individuals.length}`);
  console.log(`  Person folders created: ${createdFolders}`);
}

scaffold().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

