#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getLatestConvertedJsonPath } from './_json-latest.js';
import { displayPersonName } from './_string.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function* walkJson(value) {
  if (Array.isArray(value)) {
    for (const item of value) yield* walkJson(item);
    return;
  }
  if (!isObject(value)) return;

  yield value;
  for (const v of Object.values(value)) {
    yield* walkJson(v);
  }
}

function normalizeFormat(value) {
  if (!value) return null;
  const upper = String(value).trim().toUpperCase();
  if (!upper) return null;
  if (upper === 'JPG') return 'JPEG';
  return upper;
}

function deriveFilenameFromFileValue(fileValue, format) {
  if (!fileValue) return null;
  const raw = String(fileValue).trim();
  if (!raw) return null;

  const ext = format
    ? String(format).trim().toLowerCase().replace(/^\./, '')
    : '';

  // If it's already a local-ish filename, keep it.
  if (!/^https?:\/\//i.test(raw)) return raw;

  try {
    const url = new URL(raw);
    const guid = url.searchParams.get('guid');
    if (guid) return ext ? `${guid}.${ext}` : guid;

    const f = url.searchParams.get('f');
    if (f && ext) {
      const key = cryptoSafeSlug(`${f}-${url.searchParams.get('tid') || ''}-${url.searchParams.get('pid') || ''}`);
      return key ? `${key}.${ext}` : null;
    }

    const last = url.pathname.split('/').filter(Boolean).pop() || '';
    if (last && last.includes('.')) return last;
    return ext ? `${url.hostname}.${ext}` : url.hostname;
  } catch {
    return ext ? `media.${ext}` : 'media';
  }
}

function cryptoSafeSlug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function inferKind({ format, filename, title }) {
  const fmt = (format || '').toUpperCase();
  const name = (filename || '').toLowerCase();
  const t = (title || '').toLowerCase();

  const isImage =
    ['JPEG', 'JPG', 'PNG', 'GIF', 'TIFF', 'TIF', 'BMP', 'WEBP', 'HEIC'].includes(fmt) ||
    /\.(jpe?g|png|gif|tiff?|bmp|webp|heic)$/i.test(name);

  const isPdf = fmt === 'PDF' || name.endsWith('.pdf');

  if (isImage) return 'photos';
  if (isPdf) return 'records';
  if (t.includes('census')) return 'census';
  if (t.includes('certificate') || t.includes('birth') || t.includes('death') || t.includes('marriage')) return 'vital-records';
  return 'other';
}

function buildLocalCandidatePaths(filename) {
  if (!filename) return [];
  const safe = filename.replace(/^[\\/]+/, '');
  return [
    path.join(projectRoot, 'documents', 'unassigned', safe),
    path.join(projectRoot, 'documents', safe),
    path.join(projectRoot, 'data', 'media', safe),
    path.join(projectRoot, 'data', 'raw', safe)
  ];
}

function resolveLocalPath(filename) {
  for (const candidate of buildLocalCandidatePaths(filename)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function collectFromPerson(person) {
  const pointer = person?.id || '';
  const name = displayPersonName(person);
  const items = [];

  // 1) Preferred: scan rawTags.OBJE for nested FILE/FORM/TITL.
  const rawTags = person?.rawTags || {};
  const objes = Array.isArray(rawTags?.OBJE) ? rawTags.OBJE : [];
  for (const obje of objes) {
    const tree = Array.isArray(obje?.tree) ? obje.tree : [];
    const title = tree.find(t => t?.tag === 'TITL')?.value || null;
    const fileValue = tree.find(t => t?.tag === 'FILE')?.value || null;
    const formValue = tree.find(t => t?.tag === 'FORM')?.value || null;
    const format = normalizeFormat(formValue);
    const filename = deriveFilenameFromFileValue(fileValue, format);

    items.push({
      personId: pointer,
      personName: name,
      title: title || null,
      filename: filename || null,
      format,
      localPath: null,
      status: 'missing',
      source: 'ancestry'
    });
  }

  // 2) Fallback: use the converter’s `media` array (may not include FILE/FORM).
  if (objes.length === 0) {
    const media = Array.isArray(person?.media) ? person.media : [];
    for (const m of media) {
      const title = m?.title || null;
      const filename = m?.id || null;
      items.push({
        personId: pointer,
        personName: name,
        title,
        filename,
        format: normalizeFormat(m?.type),
        localPath: null,
        status: 'missing',
        source: 'ancestry'
      });
    }
  }

  return items;
}

async function mediaInventory() {
  const latestJsonPath = getLatestConvertedJsonPath();
  const data = JSON.parse(fs.readFileSync(latestJsonPath, 'utf-8'));
  const individuals = Array.isArray(data.individuals) ? data.individuals : [];

  const allItems = [];
  for (const person of individuals) {
    allItems.push(...collectFromPerson(person));
  }

  // De-dupe by (personId + filename + title)
  const deduped = [];
  const seen = new Set();
  for (const item of allItems) {
    const key = `${item.personId}::${item.filename || ''}::${item.title || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  let locallyAvailable = 0;
  let missingLocally = 0;
  const kindCounts = {};

  for (const item of deduped) {
    const filename = item.filename;
    const localPath = filename ? resolveLocalPath(filename) : null;
    if (localPath) {
      item.localPath = path.relative(projectRoot, localPath);
      item.status = 'available';
      locallyAvailable++;
    } else {
      item.localPath = null;
      item.status = 'missing';
      missingLocally++;
    }

    const kind = inferKind(item);
    kindCounts[kind] = (kindCounts[kind] || 0) + 1;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    totalReferences: deduped.length,
    locallyAvailable,
    missingLocally,
    items: deduped
  };

  const outPath = path.join(projectRoot, 'data', 'media-inventory.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');

  console.log(`Media inventory written: ${path.relative(projectRoot, outPath)}`);
  console.log(`  Source: ${path.relative(projectRoot, latestJsonPath)}`);
  console.log(`  Total media references: ${deduped.length}`);
  console.log(`  Locally available: ${locallyAvailable}`);
  console.log(`  Missing locally: ${missingLocally}`);
  console.log(`  By type:`);
  for (const [kind, count] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    - ${kind}: ${count}`);
  }
}

mediaInventory().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
