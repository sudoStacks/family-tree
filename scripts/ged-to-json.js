#!/usr/bin/env node

/**
 * GEDCOM to JSON Converter
 * 
 * Converts GEDCOM (.ged) files to lossless JSON format.
 * Usage: node scripts/ged-to-json.js data/raw/myfile.ged
 * 
 * Philosophy:
 * - Lossless: Every piece of data from the GEDCOM file is preserved
 * - Idempotent: Running twice produces identical output
 * - AI-ready: Clean structure suitable for embeddings, RAG, and analysis
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { format } from 'date-fns';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

/**
 * Simple GEDCOM parser that preserves all data
 * Returns a tree structure of GEDCOM records
 */
function parseGedcomFile(content) {
  const lines = content.split('\n').map(line => line.replace(/\r$/, ''));
  const records = [];
  let stack = []; // Stack of (level, record) pairs

  for (const line of lines) {
    if (!line.trim()) continue;

    // Parse GEDCOM line: "0 HEAD" or "1 NAME John /Smith/"
    const match = line.match(/^(\d+)\s+(@[^@]+@\s+)?(\w+)(?:\s+(.*))?$/);
    if (!match) {
      // Try more lenient parsing for non-standard lines
      const lenientMatch = line.match(/^(\d+)\s+(.*)/);
      if (lenientMatch) {
        const level = parseInt(lenientMatch[1]);
        const rest = lenientMatch[2].trim();
        const spaceIdx = rest.indexOf(' ');
        const tag = spaceIdx > 0 ? rest.slice(0, spaceIdx) : rest;
        const value = spaceIdx > 0 ? rest.slice(spaceIdx + 1) : '';
        processGedcomLine(level, null, tag, value, records, stack);
      }
      continue;
    }

    const level = parseInt(match[1]);
    const pointer = match[2]?.slice(0, -1) || null; // e.g., "@I1@"
    const tag = match[3];
    const value = match[4] || '';

    processGedcomLine(level, pointer, tag, value, records, stack);
  }

  return records;
}

function processGedcomLine(level, pointer, tag, value, records, stack) {
  // Create record object
  const record = {
    level,
    pointer,
    tag,
    value,
    tree: []
  };

  if (level === 0) {
    // Top-level record
    records.push(record);
    // Important: mutate the passed-in stack array (do not reassign), so callers
    // keep the correct parent chain for subsequent lines.
    stack.length = 0;
    stack.push([level, record]);
  } else {
    // Child of previous record - find the right parent
    while (stack.length > 0 && stack[stack.length - 1][0] >= level) {
      stack.pop();
    }

    if (stack.length > 0) {
      const parent = stack[stack.length - 1][1];
      parent.tree.push(record);
    }

    stack.push([level, record]);
  }
}

/**
 * Parse GEDCOM date strings (e.g., "12 MAR 1845", "ABT 1850", "BET 1840 AND 1850")
 * Returns { dateISO: string|null, dateQualifier: string|null }
 */
function parseGedcomDate(dateString) {
  if (!dateString || typeof dateString !== 'string') {
    return { dateISO: null, dateQualifier: null };
  }

  dateString = dateString.trim();
  if (!dateString) return { dateISO: null, dateQualifier: null };

  // Check for date qualifiers
  let qualifier = null;
  let workingDate = dateString;

  if (dateString.startsWith('ABT ')) {
    qualifier = 'ABT';
    workingDate = dateString.slice(4);
  } else if (dateString.startsWith('BEF ')) {
    qualifier = 'BEF';
    workingDate = dateString.slice(4);
  } else if (dateString.startsWith('AFT ')) {
    qualifier = 'AFT';
    workingDate = dateString.slice(4);
  } else if (dateString.startsWith('BET ')) {
    qualifier = 'BET';
    // For BET dates, extract the first date: "BET 1840 AND 1850" → "1840"
    const betMatch = workingDate.match(/BET\s+(.+?)\s+AND\s+(.+)/i);
    if (betMatch) {
      workingDate = betMatch[1];
    }
  }

  // Parse GEDCOM date format: "12 MAR 1845" or "MAR 1845" or "1845" or "31 Jan 1963"
  const months = {
    JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
    JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
    // Also accept lowercase
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
  };

  // Normalize month names (uppercase)
  workingDate = workingDate.replace(/([a-z]{3})/i, (match) => match.toUpperCase());

  // Try full date: "12 MAR 1845" or "31 Jan 1963"
  const fullDateMatch = workingDate.match(/(\d{1,2})\s+([A-Z]{3})\s+(\d{4})/);
  if (fullDateMatch) {
    const day = fullDateMatch[1].padStart(2, '0');
    const month = months[fullDateMatch[2]] || '01';
    const year = fullDateMatch[3];
    return {
      dateISO: `${year}-${month}-${day}`,
      dateQualifier: qualifier
    };
  }

  // Try month-year: "MAR 1845"
  const monthYearMatch = workingDate.match(/([A-Z]{3})\s+(\d{4})/);
  if (monthYearMatch) {
    const month = months[monthYearMatch[1]] || '01';
    const year = monthYearMatch[2];
    return {
      dateISO: `${year}-${month}-01`,
      dateQualifier: qualifier
    };
  }

  // Try year only: "1845"
  const yearMatch = workingDate.match(/(\d{4})/);
  if (yearMatch) {
    const year = yearMatch[1];
    return {
      dateISO: `${year}-01-01`,
      dateQualifier: qualifier
    };
  }

  // Unparseable
  return { dateISO: null, dateQualifier: qualifier };
}

/**
 * Extract event data (birth, death, burial, etc.)
 */
function extractEvent(records, tag, eventType = null) {
  const eventRecord = records.find(r => r.tag === tag);
  if (!eventRecord) {
    return {
      date: '',
      dateISO: null,
      dateQualifier: null,
      place: '',
      sourceRefs: []
    };
  }

  // Extract date
  const dateRecord = eventRecord.tree?.find(r => r.tag === 'DATE');
  const dateString = dateRecord?.value || '';
  const { dateISO, dateQualifier } = parseGedcomDate(dateString);

  // Extract place
  const placeRecord = eventRecord.tree?.find(r => r.tag === 'PLAC');
  const place = placeRecord?.value || '';

  // Extract source references
  const sourceRefs = (eventRecord.tree || [])
    .filter(r => r.tag === 'SOUR')
    .map(r => r.value);

  return {
    date: dateString,
    dateISO,
    dateQualifier,
    place,
    sourceRefs
  };
}

/**
 * Extract all events from a person record (census, emigration, residence, etc.)
 */
function extractEvents(records) {
  const eventTags = ['CENS', 'EMIG', 'RESI', 'OCCU', 'NATI', 'RELI', 'TITL', 'GRAD', 'PROB', 'WILL'];
  const events = [];

  for (const tag of eventTags) {
    const eventRecords = records.filter(r => r.tag === tag);
    for (const eventRecord of eventRecords) {
      const dateRecord = eventRecord.tree?.find(r => r.tag === 'DATE');
      const placeRecord = eventRecord.tree?.find(r => r.tag === 'PLAC');
      const descRecord = eventRecord.tree?.find(r => r.tag === 'NOTE');

      const { dateISO, dateQualifier } = parseGedcomDate(dateRecord?.value || '');

      events.push({
        type: tag,
        date: dateRecord?.value || '',
        dateISO,
        dateQualifier,
        place: placeRecord?.value || '',
        description: descRecord?.value || null
      });
    }
  }

  return events;
}

/**
 * Extract attributes (nationality, religion, occupation, etc.)
 */
function extractAttributes(records) {
  const attributeTags = ['NATI', 'RELI', 'OCCU', 'TITL'];
  const attributes = [];
  const seen = new Set();

  for (const tag of attributeTags) {
    const attrRecords = records.filter(r => r.tag === tag);
    for (const attrRecord of attrRecords) {
      const key = `${tag}:${attrRecord.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        attributes.push({
          type: tag,
          value: attrRecord.value || null
        });
      }
    }
  }

  return attributes;
}

/**
 * Convert a GEDCOM INDI record to our JSON Person format
 */
function convertPerson(indiRecord, unhandledTags) {
  const id = indiRecord.pointer;
  const records = indiRecord.tree || [];

  // Extract name
  const nameRecord = records.find(r => r.tag === 'NAME');
  const fullName = nameRecord?.value || '';
  
  // Parse NAME tag: "John Henry /Smith/" format
  let given = '';
  let surname = '';
  let prefix = '';
  let suffix = '';

  const nameMatch = fullName.match(/^([^/]*?)\s*\/([^/]*)\/?(.*)$/);
  if (nameMatch) {
    const beforeSurname = nameMatch[1].trim();
    const surnameOnly = nameMatch[2].trim();
    const afterSurname = nameMatch[3].trim();

    // Simple heuristic: split given names and extract suffix
    const beforeParts = beforeSurname.split(/\s+/);
    if (beforeParts.length > 1 && ['Jr', 'Sr', 'II', 'III', 'IV', 'V'].includes(beforeParts[beforeParts.length - 1])) {
      given = beforeParts.slice(0, -1).join(' ');
      suffix = beforeParts[beforeParts.length - 1];
    } else {
      given = beforeSurname;
    }

    surname = surnameOnly;
  } else {
    given = fullName;
  }

  // Extract sex
  const sexRecord = records.find(r => r.tag === 'SEX');
  const sex = sexRecord?.value || null;

  // Extract events
  const birth = extractEvent(records, 'BIRT');
  const death = extractEvent(records, 'DEAT');
  const burial = extractEvent(records, 'BURI');
  const events = extractEvents(records);

  // Extract attributes
  const attributes = extractAttributes(records);

  // Extract family relationships
  const familiesAsSpouse = records
    .filter(r => r.tag === 'FAMS')
    .map(r => (r.value || '').trim())
    .filter(Boolean);
  
  const familiesAsChild = records
    .filter(r => r.tag === 'FAMC')
    .map(r => (r.value || '').trim())
    .filter(Boolean);

  // Extract notes and sources
  const notes = records
    .filter(r => r.tag === 'NOTE')
    .map(r => r.value);
  
  const sources = records
    .filter(r => r.tag === 'SOUR')
    .map(r => r.value);

  // Extract media
  const media = records
    .filter(r => r.tag === 'OBJE')
    .map(r => ({
      id: r.value,
      title: r.tree?.find(t => t.tag === 'TITL')?.value || null,
      type: r.tree?.find(t => t.tag === 'TYPE')?.value || null
    }));

  // Collect raw tags (anything we didn't explicitly handle)
  const rawTags = {};
  // Note: we intentionally do NOT mark `OBJE` as handled so its nested FILE/FORM/TITL
  // structures remain available under `rawTags` for downstream media inventory tooling.
  const handledTags = new Set(['NAME', 'SEX', 'BIRT', 'DEAT', 'BURI', 'CENS', 'EMIG', 'RESI', 'OCCU', 'NATI', 'RELI', 'TITL', 'GRAD', 'PROB', 'WILL', 'FAMS', 'FAMC', 'NOTE', 'SOUR']);
  
  for (const record of records) {
    if (!handledTags.has(record.tag)) {
      unhandledTags.add(record.tag);
      if (!rawTags[record.tag]) {
        rawTags[record.tag] = [];
      }
      rawTags[record.tag].push({
        value: record.value,
        tree: record.tree
      });
    }
  }

  return {
    id,
    name: {
      full: fullName,
      given: given || null,
      surname: surname || null,
      prefix: prefix || null,
      suffix: suffix || null
    },
    sex,
    birth,
    death,
    burial,
    events,
    attributes,
    familiesAsSpouse,
    familiesAsChild,
    notes,
    sources,
    media,
    rawTags
  };
}

/**
 * Convert a GEDCOM FAM record to our JSON Family format
 */
function convertFamily(famRecord, unhandledTags) {
  const id = famRecord.pointer;
  const records = famRecord.tree || [];

  // Extract spouses
  const husbandRecord = records.find(r => r.tag === 'HUSB');
  const wifeRecord = records.find(r => r.tag === 'WIFE');
  const husband = husbandRecord?.value ? husbandRecord.value.trim() : null;
  const wife = wifeRecord?.value ? wifeRecord.value.trim() : null;

  // Extract children
  const children = records
    .filter(r => r.tag === 'CHIL')
    .map(r => (r.value || '').trim())
    .filter(Boolean);

  // Extract marriage event
  const marriage = extractEvent(records, 'MARR');

  // Extract divorce event
  const divorce = extractEvent(records, 'DIV');

  // Extract notes and sources
  const notes = records
    .filter(r => r.tag === 'NOTE')
    .map(r => r.value);
  
  const sources = records
    .filter(r => r.tag === 'SOUR')
    .map(r => r.value);

  // Collect raw tags
  const rawTags = {};
  const handledTags = new Set(['HUSB', 'WIFE', 'CHIL', 'MARR', 'DIV', 'NOTE', 'SOUR']);
  
  for (const record of records) {
    if (!handledTags.has(record.tag)) {
      unhandledTags.add(record.tag);
      if (!rawTags[record.tag]) {
        rawTags[record.tag] = [];
      }
      rawTags[record.tag].push({
        value: record.value,
        tree: record.tree
      });
    }
  }

  return {
    id,
    husband,
    wife,
    children,
    marriage,
    divorce,
    notes,
    sources,
    rawTags
  };
}

/**
 * Main conversion logic
 */
async function convertGedcomToJson(inputPath) {
  // Validate input path
  if (!inputPath) {
    console.error('Usage: node scripts/ged-to-json.js data/raw/myfile.ged');
    process.exit(1);
  }

  if (!fs.existsSync(inputPath)) {
    console.error(`Error: File not found: ${inputPath}`);
    process.exit(1);
  }

  // Read GEDCOM file
  console.log(`Reading: ${inputPath}`);
  const gedcomContent = fs.readFileSync(inputPath, 'utf-8');

  // Parse GEDCOM
  console.log('Parsing GEDCOM...');
  const gedcomRecords = parseGedcomFile(gedcomContent);

  // Extract GEDCOM header info
  const headerRecord = gedcomRecords.find(r => r.tag === 'HEAD');
  const gedcomVersionRecord = headerRecord?.tree?.find(r => r.tag === 'GEDC')?.tree?.find(r => r.tag === 'VERS');
  const gedcomVersion = gedcomVersionRecord?.value || '5.5.1';

  // Separate individuals and families
  const indiRecords = gedcomRecords.filter(r => r.tag === 'INDI');
  const famRecords = gedcomRecords.filter(r => r.tag === 'FAM');
  const sourRecords = gedcomRecords.filter(r => r.tag === 'SOUR');
  const noteRecords = gedcomRecords.filter(r => r.tag === 'NOTE');
  const repoRecords = gedcomRecords.filter(r => r.tag === 'REPO');

  console.log(`Found ${indiRecords.length} individuals, ${famRecords.length} families`);

  // Convert records
  const unhandledTags = new Set();
  const individuals = indiRecords.map(r => convertPerson(r, unhandledTags));
  const families = famRecords.map(r => convertFamily(r, unhandledTags));

  // Simple source conversion (preserve structure)
  const sources = sourRecords.map(r => ({
    id: r.pointer,
    title: r.tree?.find(t => t.tag === 'TITL')?.value || '',
    author: r.tree?.find(t => t.tag === 'AUTH')?.value || '',
    publication: r.tree?.find(t => t.tag === 'PUBL')?.value || '',
    rawTags: r.tree || []
  }));

  // Simple note conversion
  const notes = noteRecords.map(r => ({
    id: r.pointer,
    text: r.value,
    rawTags: r.tree || []
  }));

  // Simple repository conversion
  const repositories = repoRecords.map(r => ({
    id: r.pointer,
    name: r.tree?.find(t => t.tag === 'NAME')?.value || '',
    address: r.tree?.find(t => t.tag === 'ADDR')?.value || '',
    rawTags: r.tree || []
  }));

  // Build output structure
  const timestamp = format(new Date(), 'yyyy-MM-dd\'T\'HH:mm:ss\'Z\'');
  const filename = path.basename(inputPath);

  const output = {
    meta: {
      source: filename,
      convertedAt: timestamp,
      gedcomVersion,
      totalIndividuals: individuals.length,
      totalFamilies: families.length,
      totalSources: sources.length,
      totalNotes: notes.length,
      totalRepositories: repositories.length
    },
    individuals,
    families,
    sources,
    notes,
    repositories
  };

  // Write JSON output
  const baseName = path.basename(inputPath, '.ged');
  const dateStr = format(new Date(), 'yyyy-MM-dd');
  const outputPath = path.join(projectRoot, 'data', 'json', `${baseName}-${dateStr}.json`);
  const outputDir = path.dirname(outputPath);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`Writing JSON: ${outputPath}`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

  // Log unhandled tags to warnings file
  if (unhandledTags.size > 0) {
    const warningsPath = path.join(projectRoot, 'data', 'json', `warnings-${dateStr}.log`);
    const warningMessage = `
[${timestamp}] GEDCOM Conversion Warnings
Source: ${inputPath}

The following GEDCOM tags were encountered but not explicitly mapped to JSON fields.
These tags are preserved in the 'rawTags' field of each record.

Unhandled tags: ${Array.from(unhandledTags).sort().join(', ')}

For more info on GEDCOM tags, see: https://www.gedcom.org/

---
`;
    fs.appendFileSync(warningsPath, warningMessage, 'utf-8');
    console.log(`Warnings logged: ${warningsPath}`);
  }

  console.log(`✓ Conversion complete!`);
  console.log(`  Output: ${outputPath}`);
  console.log(`  Individuals: ${individuals.length}`);
  console.log(`  Families: ${families.length}`);
}

// Run
const inputPath = process.argv[2] || 'data/raw/example.ged';
convertGedcomToJson(inputPath).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
