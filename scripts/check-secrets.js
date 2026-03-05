#!/usr/bin/env node
/**
 * Check for accidental secrets in source code (no .env — we never commit that).
 * Scans src/ and scripts/ for patterns: OpenAI sk-*, api_key="...", password="...", Bearer tokens.
 * Used in npm run security:check. Exits 0 if clean, 1 and prints matches if found.
 *
 * Run: node scripts/check-secrets.js  or  npm run check-secrets
 */

import fs from 'fs';
import path from 'path';

const ROOTS = ['src', 'scripts'];
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json'];
const EXCLUDE_DIRS = ['node_modules', 'dist', '.git'];

// Patterns that suggest a secret might be hardcoded (avoid false positives: no "sk-" in comments only is hard)
const PATTERNS = [
  { name: 'OpenAI-style API key', regex: /sk-[a-zA-Z0-9]{20,}/ },
  { name: 'Generic API key assignment', regex: /(?:api[_-]?key|apikey|secret)\s*=\s*['"][^'"]{8,}['"]/i },
  { name: 'Password in code', regex: /(?:password|passphrase|passwd)\s*=\s*['"][^'"]+['"]/i },
  { name: 'Bearer token', regex: /Bearer\s+[a-zA-Z0-9_\-.]{20,}/ },
];

function walkDir(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!EXCLUDE_DIRS.includes(e.name)) walkDir(full, fileList);
    } else if (EXTENSIONS.some(ext => e.name.endsWith(ext))) {
      fileList.push(full);
    }
  }
  return fileList;
}

function checkFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const hits = [];
  for (const p of PATTERNS) {
    lines.forEach((line, i) => {
      // Skip lines that are only comments (reduce false positives)
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      const m = line.match(p.regex);
      if (m) hits.push({ file: filePath, lineNum: i + 1, pattern: p.name, match: m[0].slice(0, 30) + '...' });
    });
  }
  return hits;
}

let totalHits = [];
for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  const files = walkDir(root);
  for (const f of files) {
    const hits = checkFile(f);
    if (hits && hits.length) totalHits = totalHits.concat(hits);
  }
}

if (totalHits.length > 0) {
  console.error('Possible secrets found in source (do not commit secrets):\n');
  totalHits.forEach(h => {
    console.error(`  ${h.file}:${h.lineNum}  [${h.pattern}]  ${h.match}`);
  });
  process.exit(1);
}

console.log('check-secrets: no obvious secrets found in src/ or scripts/.');
process.exit(0);
