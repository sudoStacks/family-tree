import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

export function getLatestConvertedJsonPath() {
  const dir = path.join(projectRoot, 'data', 'json');
  if (!fs.existsSync(dir)) {
    throw new Error(`Missing directory: ${dir}`);
  }

  const candidates = fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.json') && !name.startsWith('warnings-'))
    .map(name => {
      const fullPath = path.join(dir, name);
      const stat = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`No converted JSON files found in ${dir}`);
  }

  return candidates[0].fullPath;
}

