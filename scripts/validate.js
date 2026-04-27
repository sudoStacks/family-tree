#!/usr/bin/env node

/**
 * JSON Validation Script
 * 
 * Validates converted JSON output against the person.schema.json schema.
 * Usage: node scripts/validate.js data/json/myfile-2024-01-01.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

async function validateJson(jsonPath) {
  // Validate input path
  if (!jsonPath) {
    console.error('Usage: node scripts/validate.js data/json/myfile-2024-01-01.json');
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

  // Load schema
  const schemaPath = path.join(projectRoot, 'schema', 'person.schema.json');
  const schemaContent = fs.readFileSync(schemaPath, 'utf-8');
  const schema = JSON.parse(schemaContent);

  // Set up AJV validator
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(schema);

  // Validate individuals
  console.log('\nValidating individuals...');
  let passedCount = 0;
  let failedCount = 0;
  const errors = [];

  if (data.individuals && Array.isArray(data.individuals)) {
    for (let i = 0; i < data.individuals.length; i++) {
      const person = data.individuals[i];
      const isValid = validate(person);

      if (isValid) {
        passedCount++;
      } else {
        failedCount++;
        errors.push({
          index: i,
          id: person.id,
          errors: validate.errors
        });
      }
    }
  }

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('VALIDATION SUMMARY');
  console.log(`${'='.repeat(60)}`);
  console.log(`Total individuals: ${passedCount + failedCount}`);
  console.log(`✓ Passed: ${passedCount}`);
  console.log(`✗ Failed: ${failedCount}`);

  if (failedCount > 0) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('ERRORS');
    console.log(`${'='.repeat(60)}`);

    for (const error of errors.slice(0, 10)) {
      console.log(`\nPerson #${error.index} (${error.id}):`);
      for (const err of error.errors) {
        console.log(`  - ${err.instancePath || 'root'}: ${err.message}`);
        if (err.params) {
          console.log(`    ${JSON.stringify(err.params)}`);
        }
      }
    }

    if (errors.length > 10) {
      console.log(`\n... and ${errors.length - 10} more errors`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  process.exit(failedCount > 0 ? 1 : 0);
}

// Run
const jsonPath = process.argv[2];
validateJson(jsonPath).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
