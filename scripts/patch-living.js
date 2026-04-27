#!/usr/bin/env node

import fs from 'fs';

import { getLatestConvertedJsonPath } from './_json-latest.js';

function hasAnyDeathSignal(person) {
  // If rawTags includes a DEAT record at any top-level tag bucket, treat as not-living.
  const rawTags = person?.rawTags || {};
  if (rawTags && typeof rawTags === 'object' && Array.isArray(rawTags.DEAT) && rawTags.DEAT.length > 0) {
    return true;
  }
  return false;
}

async function main() {
  const jsonPath = getLatestConvertedJsonPath();
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const individuals = Array.isArray(data.individuals) ? data.individuals : [];

  let livingCount = 0;
  let notLivingCount = 0;

  for (const person of individuals) {
    const birthISO = person?.birth?.dateISO || null;
    const deathISO = person?.death?.dateISO || null;
    const deathSignal = hasAnyDeathSignal(person);

    const isLiving = birthISO === null && deathISO === null && !deathSignal;
    person.living = isLiving;
    if (isLiving) livingCount++;
    else notLivingCount++;
  }

  fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), 'utf-8');

  console.log('Living patch complete');
  console.log(`  File: ${jsonPath}`);
  console.log(`  Living: ${livingCount}`);
  console.log(`  Not living: ${notLivingCount}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

