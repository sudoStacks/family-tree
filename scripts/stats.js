#!/usr/bin/env node

/**
 * Statistics Script
 * 
 * Print human-readable statistics from a converted JSON file.
 * Usage: node scripts/stats.js data/json/myfile-2024-01-01.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

function getTopItems(items, limit = 10) {
  const counts = {};
  for (const item of items) {
    counts[item] = (counts[item] || 0) + 1;
  }

  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

async function printStats(jsonPath) {
  // Validate input path
  if (!jsonPath) {
    console.error('Usage: node scripts/stats.js data/json/myfile-2024-01-01.json');
    process.exit(1);
  }

  if (!fs.existsSync(jsonPath)) {
    console.error(`Error: File not found: ${jsonPath}`);
    process.exit(1);
  }

  // Load JSON file
  console.log(`Reading: ${jsonPath}`);
  const jsonContent = fs.readFileSync(jsonPath, 'utf-8');
  let data;
  try {
    data = JSON.parse(jsonContent);
  } catch (err) {
    console.error('Error parsing JSON:', err.message);
    process.exit(1);
  }

  // Collect statistics
  const stats = {
    totalIndividuals: 0,
    totalFamilies: 0,
    totalSources: 0,
    totalNotes: 0,
    totalRepositories: 0,
    maleCount: 0,
    femaleCount: 0,
    unknownSexCount: 0,
    birthYears: [],
    deathYears: [],
    surnames: [],
    birthplaces: []
  };

  // Process individuals
  if (data.individuals && Array.isArray(data.individuals)) {
    stats.totalIndividuals = data.individuals.length;

    for (const person of data.individuals) {
      // Count by sex
      if (person.sex === 'M') stats.maleCount++;
      else if (person.sex === 'F') stats.femaleCount++;
      else stats.unknownSexCount++;

      // Extract birth year
      if (person.birth?.dateISO) {
        const year = parseInt(person.birth.dateISO.slice(0, 4));
        if (!isNaN(year)) stats.birthYears.push(year);
      }

      // Extract death year
      if (person.death?.dateISO) {
        const year = parseInt(person.death.dateISO.slice(0, 4));
        if (!isNaN(year)) stats.deathYears.push(year);
      }

      // Extract surname
      if (person.name?.surname) {
        stats.surnames.push(person.name.surname);
      }

      // Extract birthplace
      if (person.birth?.place) {
        stats.birthplaces.push(person.birth.place);
      }
    }
  }

  // Process families
  if (data.families && Array.isArray(data.families)) {
    stats.totalFamilies = data.families.length;
  }

  // Process other record types
  if (data.sources && Array.isArray(data.sources)) {
    stats.totalSources = data.sources.length;
  }
  if (data.notes && Array.isArray(data.notes)) {
    stats.totalNotes = data.notes.length;
  }
  if (data.repositories && Array.isArray(data.repositories)) {
    stats.totalRepositories = data.repositories.length;
  }

  // Compute aggregates
  const birthYears = stats.birthYears.sort((a, b) => a - b);
  const deathYears = stats.deathYears.sort((a, b) => a - b);
  const topSurnames = getTopItems(stats.surnames, 10);
  const topPlaces = getTopItems(stats.birthplaces, 10);

  // Print report
  console.log(`\n${'='.repeat(70)}`);
  console.log('FAMILY TREE STATISTICS');
  console.log(`${'='.repeat(70)}`);

  if (data.meta) {
    console.log(`\nSource File: ${data.meta.source}`);
    console.log(`Converted: ${data.meta.convertedAt}`);
    console.log(`GEDCOM Version: ${data.meta.gedcomVersion}`);
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log('RECORD COUNTS');
  console.log(`${'─'.repeat(70)}`);
  console.log(`Individuals:   ${stats.totalIndividuals}`);
  console.log(`  - Male:      ${stats.maleCount} (${((stats.maleCount / stats.totalIndividuals) * 100).toFixed(1)}%)`);
  console.log(`  - Female:    ${stats.femaleCount} (${((stats.femaleCount / stats.totalIndividuals) * 100).toFixed(1)}%)`);
  console.log(`  - Unknown:   ${stats.unknownSexCount} (${((stats.unknownSexCount / stats.totalIndividuals) * 100).toFixed(1)}%)`);
  console.log(`Families:      ${stats.totalFamilies}`);
  console.log(`Sources:       ${stats.totalSources}`);
  console.log(`Notes:         ${stats.totalNotes}`);
  console.log(`Repositories:  ${stats.totalRepositories}`);

  if (birthYears.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log('DATE RANGES');
    console.log(`${'─'.repeat(70)}`);
    console.log(`Earliest birth: ${birthYears[0]}`);
    console.log(`Latest birth:   ${birthYears[birthYears.length - 1]}`);
    if (deathYears.length > 0) {
      console.log(`Earliest death: ${deathYears[0]}`);
      console.log(`Latest death:   ${deathYears[deathYears.length - 1]}`);
    }
  }

  if (topSurnames.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log('TOP 10 SURNAMES');
    console.log(`${'─'.repeat(70)}`);
    for (const { name, count } of topSurnames) {
      console.log(`${name.padEnd(30)} ${count}`);
    }
  }

  if (topPlaces.length > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log('TOP 10 BIRTHPLACES');
    console.log(`${'─'.repeat(70)}`);
    for (const { name, count } of topPlaces) {
      console.log(`${name.padEnd(50)} ${count}`);
    }
  }

  console.log(`\n${'='.repeat(70)}\n`);
}

// Run
const jsonPath = process.argv[2];
printStats(jsonPath).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
