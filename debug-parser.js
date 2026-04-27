#!/usr/bin/env node

import fs from 'fs';

function parseGedcomFile(content) {
  const lines = content.split('\n').map(line => line.replace(/\r$/, ''));
  const records = [];
  let stack = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    const match = line.match(/^(\d+)\s+(@[^@]+@\s+)?(\w+)(?:\s+(.*))?$/);
    if (!match) continue;

    const level = parseInt(match[1]);
    const pointer = match[2]?.slice(0, -1) || null;
    const tag = match[3];
    const value = match[4] || '';

    const record = { level, pointer, tag, value, tree: [] };

    if (level === 0) {
      records.push(record);
      stack = [[0, record]];
    } else {
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
  return records;
}

const inputPath = process.argv[2] || 'data/raw/example.ged';
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  console.error('Usage: node debug-parser.js data/raw/yourfile.ged');
  process.exit(1);
}

const content = fs.readFileSync(inputPath, 'utf-8');
const records = parseGedcomFile(content);
const indiRecords = records.filter(r => r.tag === 'INDI').slice(0, 2);

indiRecords.forEach(indi => {
  console.log('\nINDI:', indi.pointer);
  console.log('  Tree length:', indi.tree.length);
  const nameRecord = indi.tree.find(r => r.tag === 'NAME');
  console.log('  NAME record:', nameRecord ? nameRecord.value : 'NOT FOUND');
  const birtRecord = indi.tree.find(r => r.tag === 'BIRT');
  if (birtRecord) {
    const dateRecord = birtRecord.tree.find(r => r.tag === 'DATE');
    console.log('  BIRT DATE:', dateRecord ? dateRecord.value : 'NOT FOUND');
  }
});
