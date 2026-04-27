#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { getLatestConvertedJsonPath } from './_json-latest.js';

/**
 * NOTE: This script contains dataset-specific person IDs (@P3607@, @P3256@) and is
 * intentionally not generic.
 *
 * Users of this repo should replace these IDs with the error IDs surfaced by their
 * own `npm run verify` output. See `data/verification-report-*.json` for your
 * specific errors.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const MANUAL_REVIEW_PATH = path.join(projectRoot, 'data', 'manual-review.json');
const PATCH_LOG_PATH = path.join(projectRoot, 'data', 'patch-log.json');

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}

function isEmpty(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

async function main() {
  const jsonPath = getLatestConvertedJsonPath();
  const tree = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const individuals = Array.isArray(tree.individuals) ? tree.individuals : [];

  // NOTE: This script is intentionally dataset-specific (targets known-bad IDs).
  // Keep it out of generic pipelines unless you know your dataset uses the same IDs.

  let manualFlagged = 0;
  let swapped = 0;

  // Manual review registry
  const manual = readJson(MANUAL_REVIEW_PATH, { generatedAt: null, items: [] });
  manual.items = Array.isArray(manual.items) ? manual.items : [];

  // Patch log
  const patchLog = readJson(PATCH_LOG_PATH, { generatedAt: null, patches: [] });
  patchLog.patches = Array.isArray(patchLog.patches) ? patchLog.patches : [];

  // @P3607@: missing name.full
  const p3607 = individuals.find(p => p?.id === '@P3607@');
  if (p3607 && isEmpty(p3607?.name?.full)) {
    const already = manual.items.some(i => i?.personId === '@P3607@' && i?.issue === 'missing_name_full');
    if (!already) {
      manual.items.push({
        personId: '@P3607@',
        issue: 'missing_name_full',
        note: 'name.full is empty/null; needs human correction',
        createdAt: new Date().toISOString()
      });
      manualFlagged++;
    }
  }

  // @P3256@: swap inverted birth/death
  const p3256 = individuals.find(p => p?.id === '@P3256@');
  if (p3256) {
    const before = {
      birth: {
        date: p3256?.birth?.date || '',
        dateISO: p3256?.birth?.dateISO || null
      },
      death: {
        date: p3256?.death?.date || '',
        dateISO: p3256?.death?.dateISO || null
      }
    };

    const shouldSwap =
      before.birth.dateISO &&
      before.death.dateISO &&
      String(before.birth.dateISO).slice(0, 4) > String(before.death.dateISO).slice(0, 4);

    if (shouldSwap) {
      const alreadyPatched = patchLog.patches.some(p => p?.personId === '@P3256@' && p?.action === 'swap_birth_death');
      if (!alreadyPatched) {
        // Ensure birth/death objects exist
        p3256.birth = p3256.birth || { date: '', dateISO: null, dateQualifier: null, place: '', sourceRefs: [] };
        p3256.death = p3256.death || { date: '', dateISO: null, dateQualifier: null, place: '', sourceRefs: [] };

        // Swap date + dateISO + qualifier
        const tmpBirth = {
          date: p3256.birth.date,
          dateISO: p3256.birth.dateISO,
          dateQualifier: p3256.birth.dateQualifier
        };
        p3256.birth.date = p3256.death.date;
        p3256.birth.dateISO = p3256.death.dateISO;
        p3256.birth.dateQualifier = p3256.death.dateQualifier;

        p3256.death.date = tmpBirth.date;
        p3256.death.dateISO = tmpBirth.dateISO;
        p3256.death.dateQualifier = tmpBirth.dateQualifier;

        const after = {
          birth: {
            date: p3256?.birth?.date || '',
            dateISO: p3256?.birth?.dateISO || null
          },
          death: {
            date: p3256?.death?.date || '',
            dateISO: p3256?.death?.dateISO || null
          }
        };

        patchLog.patches.push({
          personId: '@P3256@',
          action: 'swap_birth_death',
          appliedAt: new Date().toISOString(),
          before,
          after
        });
        swapped++;
      }
    }
  }

  manual.generatedAt = new Date().toISOString();
  patchLog.generatedAt = new Date().toISOString();

  if (manualFlagged > 0) writeJsonAtomic(MANUAL_REVIEW_PATH, manual);
  if (swapped > 0) writeJsonAtomic(PATCH_LOG_PATH, patchLog);

  fs.writeFileSync(jsonPath, JSON.stringify(tree, null, 2), 'utf-8');

  console.log('Error patch complete');
  console.log(`  File: ${jsonPath}`);
  console.log(`  Manual review items added: ${manualFlagged}`);
  console.log(`  Birth/death swaps applied: ${swapped}`);
  if (manualFlagged > 0) console.log(`  Manual review: ${path.relative(projectRoot, MANUAL_REVIEW_PATH)}`);
  if (swapped > 0) console.log(`  Patch log: ${path.relative(projectRoot, PATCH_LOG_PATH)}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
