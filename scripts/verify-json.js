#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { format } from 'date-fns';

import { getLatestConvertedJsonPath } from './_json-latest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

function yearFromISO(dateISO) {
  if (!dateISO || typeof dateISO !== 'string') return null;
  const m = dateISO.match(/^(\d{4})-/);
  if (!m) return null;
  const year = Number(m[1]);
  return Number.isFinite(year) ? year : null;
}

function computeAgeYears(birthISO, deathISO) {
  const by = yearFromISO(birthISO);
  const dy = yearFromISO(deathISO);
  if (by === null || dy === null) return null;
  return dy - by;
}

function addIssue(list, issue) {
  list.push({
    code: issue.code,
    severity: issue.severity,
    message: issue.message,
    entityType: issue.entityType || null,
    entityId: issue.entityId || null,
    details: issue.details || null
  });
}

function percentileBuckets(values, buckets) {
  const counts = {};
  for (const b of buckets) counts[b] = 0;
  for (const v of values) {
    for (const b of buckets) {
      const [min, max] = b.split('-').map(Number);
      if (v >= min && v <= max) {
        counts[b]++;
        break;
      }
    }
  }
  return counts;
}

function completenessScore(person) {
  let score = 0;
  const hasBirthDate = Boolean(person?.birth?.dateISO);
  const hasBirthPlace = Boolean(person?.birth?.place);
  const hasDeathDate = Boolean(person?.death?.dateISO);
  const hasDeathPlace = Boolean(person?.death?.place);
  const hasFamilyLink =
    (Array.isArray(person?.familiesAsSpouse) && person.familiesAsSpouse.length > 0) ||
    (Array.isArray(person?.familiesAsChild) && person.familiesAsChild.length > 0);
  const hasSourceCitation =
    (Array.isArray(person?.birth?.sourceRefs) && person.birth.sourceRefs.length > 0) ||
    (Array.isArray(person?.death?.sourceRefs) && person.death.sourceRefs.length > 0) ||
    (Array.isArray(person?.sources) && person.sources.length > 0);

  if (hasBirthDate) score += 20;
  if (hasBirthPlace) score += 10;
  // "or living flag" – we don't currently have a living flag, so only award on death date.
  if (hasDeathDate) score += 20;
  if (hasDeathPlace) score += 10;
  if (hasFamilyLink) score += 20;
  if (hasSourceCitation) score += 20;
  return score;
}

async function verify() {
  const latestJsonPath = getLatestConvertedJsonPath();
  const data = JSON.parse(fs.readFileSync(latestJsonPath, 'utf-8'));

  const individuals = Array.isArray(data.individuals) ? data.individuals : [];
  const families = Array.isArray(data.families) ? data.families : [];

  const errors = [];
  const warnings = [];

  // ID uniqueness + existence maps
  const individualIds = new Set();
  const familyIds = new Set();
  const duplicateIndividuals = new Set();
  const duplicateFamilies = new Set();

  for (const p of individuals) {
    if (!p?.id) continue;
    if (individualIds.has(p.id)) duplicateIndividuals.add(p.id);
    individualIds.add(p.id);
  }
  for (const f of families) {
    if (!f?.id) continue;
    if (familyIds.has(f.id)) duplicateFamilies.add(f.id);
    familyIds.add(f.id);
  }

  for (const id of duplicateIndividuals) {
    addIssue(errors, {
      code: 'DUPLICATE_INDIVIDUAL_ID',
      severity: 'error',
      message: `Duplicate individual id: ${id}`,
      entityType: 'individual',
      entityId: id
    });
  }
  for (const id of duplicateFamilies) {
    addIssue(errors, {
      code: 'DUPLICATE_FAMILY_ID',
      severity: 'error',
      message: `Duplicate family id: ${id}`,
      entityType: 'family',
      entityId: id
    });
  }

  // Structural checks: individual required fields
  for (const person of individuals) {
    if (!person?.id) {
      addIssue(errors, {
        code: 'MISSING_PERSON_ID',
        severity: 'error',
        message: 'Individual missing id',
        entityType: 'individual'
      });
      continue;
    }

    if (!person?.name?.full) {
      addIssue(errors, {
        code: 'MISSING_NAME_FULL',
        severity: 'error',
        message: 'Individual missing name.full',
        entityType: 'individual',
        entityId: person.id
      });
    }

    // Required in prompt (can be null/empty, but must exist)
    if (!Object.prototype.hasOwnProperty.call(person, 'sex')) {
      addIssue(errors, {
        code: 'MISSING_SEX_FIELD',
        severity: 'error',
        message: 'Individual missing sex field',
        entityType: 'individual',
        entityId: person.id
      });
    }
  }

  // Structural checks: family references point to existing individuals
  for (const fam of families) {
    if (!fam?.id) {
      addIssue(errors, {
        code: 'MISSING_FAMILY_ID',
        severity: 'error',
        message: 'Family missing id',
        entityType: 'family'
      });
      continue;
    }

    const refs = [
      { role: 'husband', id: fam.husband },
      { role: 'wife', id: fam.wife }
    ];
    for (const childId of Array.isArray(fam.children) ? fam.children : []) {
      refs.push({ role: 'child', id: childId });
    }

    for (const ref of refs) {
      if (!ref.id) continue;
      if (!individualIds.has(ref.id)) {
        addIssue(errors, {
          code: 'FAMILY_REF_MISSING_INDIVIDUAL',
          severity: 'error',
          message: `Family references missing individual (${ref.role}): ${ref.id}`,
          entityType: 'family',
          entityId: fam.id,
          details: { role: ref.role, referencedId: ref.id }
        });
      }
    }
  }

  // Structural checks: person family references exist
  for (const person of individuals) {
    if (!person?.id) continue;
    const spouseRefs = Array.isArray(person.familiesAsSpouse) ? person.familiesAsSpouse : [];
    const childRefs = Array.isArray(person.familiesAsChild) ? person.familiesAsChild : [];

    for (const fid of spouseRefs) {
      if (!familyIds.has(fid)) {
        addIssue(errors, {
          code: 'PERSON_REF_MISSING_FAMILY',
          severity: 'error',
          message: `Individual references missing family (familiesAsSpouse): ${fid}`,
          entityType: 'individual',
          entityId: person.id,
          details: { field: 'familiesAsSpouse', referencedId: fid }
        });
      }
    }
    for (const fid of childRefs) {
      if (!familyIds.has(fid)) {
        addIssue(errors, {
          code: 'PERSON_REF_MISSING_FAMILY',
          severity: 'error',
          message: `Individual references missing family (familiesAsChild): ${fid}`,
          entityType: 'individual',
          entityId: person.id,
          details: { field: 'familiesAsChild', referencedId: fid }
        });
      }
    }
  }

  // No orphaned families (no members)
  for (const fam of families) {
    if (!fam?.id) continue;
    const hasSpouse = Boolean(fam.husband || fam.wife);
    const hasChildren = Array.isArray(fam.children) && fam.children.length > 0;
    if (!hasSpouse && !hasChildren) {
      addIssue(warnings, {
        code: 'ORPHANED_FAMILY',
        severity: 'warning',
        message: `Family has no members`,
        entityType: 'family',
        entityId: fam.id
      });
    }
  }

  // Relationship integrity maps for families
  const familyById = new Map();
  for (const fam of families) {
    if (fam?.id) familyById.set(fam.id, fam);
  }

  // Relationship integrity: child/spouse reverse links exist
  for (const fam of families) {
    if (!fam?.id) continue;

    const childIds = Array.isArray(fam.children) ? fam.children : [];
    for (const childId of childIds) {
      const child = individuals.find(p => p?.id === childId);
      if (!child) continue;
      const famc = Array.isArray(child.familiesAsChild) ? child.familiesAsChild : [];
      if (!famc.includes(fam.id)) {
        addIssue(warnings, {
          code: 'CHILD_MISSING_REVERSE_LINK',
          severity: 'warning',
          message: `Child is in family.children but does not list family in familiesAsChild`,
          entityType: 'family',
          entityId: fam.id,
          details: { childId }
        });
      }
    }

    for (const spouseField of ['husband', 'wife']) {
      const spouseId = fam[spouseField];
      if (!spouseId) continue;
      const spouse = individuals.find(p => p?.id === spouseId);
      if (!spouse) continue;
      const fams = Array.isArray(spouse.familiesAsSpouse) ? spouse.familiesAsSpouse : [];
      if (!fams.includes(fam.id)) {
        addIssue(warnings, {
          code: 'SPOUSE_MISSING_REVERSE_LINK',
          severity: 'warning',
          message: `Spouse is referenced in family but does not list family in familiesAsSpouse`,
          entityType: 'family',
          entityId: fam.id,
          details: { spouseField, spouseId }
        });
      }
    }
  }

  // Individuals with > 2 entries in familiesAsChild
  for (const person of individuals) {
    if (!person?.id) continue;
    const famc = Array.isArray(person.familiesAsChild) ? person.familiesAsChild : [];
    if (famc.length > 2) {
      addIssue(warnings, {
        code: 'MULTIPLE_FAMC_LINKS',
        severity: 'warning',
        message: `Individual has more than 2 familiesAsChild links (${famc.length})`,
        entityType: 'individual',
        entityId: person.id,
        details: { familiesAsChild: famc }
      });
    }
  }

  // Data quality checks
  let isoFailures = 0;
  for (const person of individuals) {
    if (!person?.id) continue;

    // Missing surname
    if (!person?.name?.surname) {
      addIssue(warnings, {
        code: 'MISSING_SURNAME',
        severity: 'warning',
        message: 'Individual missing surname',
        entityType: 'individual',
        entityId: person.id
      });
    }

    // No birth date and no death date
    if (!person?.birth?.dateISO && !person?.death?.dateISO) {
      addIssue(warnings, {
        code: 'NO_BIRTH_AND_NO_DEATH_DATE',
        severity: 'warning',
        message: 'Individual has neither birth dateISO nor death dateISO',
        entityType: 'individual',
        entityId: person.id
      });
    }

    const by = yearFromISO(person?.birth?.dateISO);
    const dy = yearFromISO(person?.death?.dateISO);

    // Birth year after death year
    if (by !== null && dy !== null && by > dy) {
      addIssue(errors, {
        code: 'BIRTH_AFTER_DEATH',
        severity: 'error',
        message: `Birth year (${by}) is after death year (${dy})`,
        entityType: 'individual',
        entityId: person.id
      });
    }

    // Age at death > 110
    const age = computeAgeYears(person?.birth?.dateISO, person?.death?.dateISO);
    if (age !== null && age > 110) {
      addIssue(warnings, {
        code: 'AGE_AT_DEATH_GT_110',
        severity: 'warning',
        message: `Age at death appears > 110 (${age} years)`,
        entityType: 'individual',
        entityId: person.id
      });
    }

    // Birth year before 1600
    if (by !== null && by < 1600) {
      addIssue(warnings, {
        code: 'BIRTH_BEFORE_1600',
        severity: 'warning',
        message: `Birth year is before 1600 (${by})`,
        entityType: 'individual',
        entityId: person.id
      });
    }

    // ISO conversion failures count (date present but ISO null)
    const datePairs = [
      { raw: person?.birth?.date, iso: person?.birth?.dateISO, label: 'birth' },
      { raw: person?.death?.date, iso: person?.death?.dateISO, label: 'death' },
      { raw: person?.burial?.date, iso: person?.burial?.dateISO, label: 'burial' }
    ];
    for (const d of datePairs) {
      if (d.raw && !d.iso) isoFailures++;
    }
  }

  // Family data quality checks involving spouse/children dates
  const personById = new Map();
  for (const p of individuals) {
    if (p?.id) personById.set(p.id, p);
  }

  for (const fam of families) {
    if (!fam?.id) continue;

    const marriageISO = fam?.marriage?.dateISO || null;
    const marriageYear = yearFromISO(marriageISO);

    const husband = fam.husband ? personById.get(fam.husband) : null;
    const wife = fam.wife ? personById.get(fam.wife) : null;
    const husbandBirthYear = yearFromISO(husband?.birth?.dateISO);
    const wifeBirthYear = yearFromISO(wife?.birth?.dateISO);

    // Marriage date before spouse birth date
    if (marriageYear !== null) {
      if (husbandBirthYear !== null && marriageYear < husbandBirthYear) {
        addIssue(warnings, {
          code: 'MARRIAGE_BEFORE_SPOUSE_BIRTH',
          severity: 'warning',
          message: `Marriage year (${marriageYear}) is before husband's birth year (${husbandBirthYear})`,
          entityType: 'family',
          entityId: fam.id
        });
      }
      if (wifeBirthYear !== null && marriageYear < wifeBirthYear) {
        addIssue(warnings, {
          code: 'MARRIAGE_BEFORE_SPOUSE_BIRTH',
          severity: 'warning',
          message: `Marriage year (${marriageYear}) is before wife's birth year (${wifeBirthYear})`,
          entityType: 'family',
          entityId: fam.id
        });
      }
    }

    // Children "born before parents" heuristic: child birth year < mother birth year + 12
    const childIds = Array.isArray(fam.children) ? fam.children : [];
    for (const childId of childIds) {
      const child = personById.get(childId);
      if (!child) continue;
      const childBirthYear = yearFromISO(child?.birth?.dateISO);
      if (wifeBirthYear !== null && childBirthYear !== null && childBirthYear < wifeBirthYear + 12) {
        addIssue(warnings, {
          code: 'CHILD_BORN_TOO_EARLY_FOR_MOTHER',
          severity: 'warning',
          message: `Child birth year (${childBirthYear}) is < mother birth year + 12 (${wifeBirthYear + 12})`,
          entityType: 'family',
          entityId: fam.id,
          details: { childId, motherId: fam.wife }
        });
      }
    }
  }

  // Completeness report
  const completenessScores = individuals
    .filter(p => p?.id)
    .map(p => ({
      personId: p.id,
      score: completenessScore(p)
    }));

  const scoreValues = completenessScores.map(s => s.score);
  const avgScore =
    scoreValues.length > 0 ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length : 0;
  const distribution = percentileBuckets(scoreValues, ['0-19', '20-39', '40-59', '60-79', '80-100']);

  // Summary
  const summary = {
    totalIndividuals: individuals.length,
    totalFamilies: families.length,
    passedAllChecks: errors.length === 0 ? 1 : 0,
    warnings: warnings.length,
    errors: errors.length,
    averageCompletenessScore: Number(avgScore.toFixed(2)),
    dateIsoFailures: isoFailures,
    completenessDistribution: distribution
  };

  const recommendations = [];
  if (isoFailures > 0) {
    recommendations.push('Review GEDCOM date strings that did not convert to ISO (dateISO is null).');
  }
  if (warnings.some(w => w.code === 'MISSING_SURNAME')) {
    recommendations.push('Fill missing surnames for improved indexing and folder naming.');
  }
  if (warnings.some(w => w.code === 'NO_BIRTH_AND_NO_DEATH_DATE')) {
    recommendations.push('Prioritize adding at least one vital date (birth/death) for individuals with neither.');
  }

  const report = {
    summary,
    errors,
    warnings,
    completenessScores,
    recommendations
  };

  // Write report
  const dateStr = format(new Date(), 'yyyy-MM-dd');
  const outPath = path.join(projectRoot, 'data', `verification-report-${dateStr}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf-8');

  // Console summary
  console.log('Deep Verification Summary');
  console.log('='.repeat(70));
  console.log(`Source: ${path.relative(projectRoot, latestJsonPath)}`);
  console.log(`Individuals: ${summary.totalIndividuals}`);
  console.log(`Families: ${summary.totalFamilies}`);
  console.log(`Errors: ${summary.errors}`);
  console.log(`Warnings: ${summary.warnings}`);
  console.log(`Avg completeness: ${summary.averageCompletenessScore}`);
  console.log(`Date ISO failures: ${summary.dateIsoFailures}`);
  console.log(`Completeness distribution:`);
  for (const [bucket, count] of Object.entries(summary.completenessDistribution)) {
    console.log(`  - ${bucket}: ${count}`);
  }
  console.log(`Report: ${path.relative(projectRoot, outPath)}`);

  if (errors.length > 0) {
    console.log('\nTop errors:');
    for (const e of errors.slice(0, 10)) {
      console.log(`  - [${e.code}] ${e.message} (${e.entityType}:${e.entityId || 'n/a'})`);
    }
  }
  if (warnings.length > 0) {
    console.log('\nTop warnings:');
    for (const w of warnings.slice(0, 10)) {
      console.log(`  - [${w.code}] ${w.message} (${w.entityType}:${w.entityId || 'n/a'})`);
    }
  }
}

verify().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

