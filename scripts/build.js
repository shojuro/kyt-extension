#!/usr/bin/env node

/**
 * Build script for KYT Chrome Extension (MV3)
 *
 * Packages extension files into dist/ for Chrome Web Store upload.
 * No transpilation needed — MV3 service workers support ES modules natively.
 *
 * Usage:
 *   npm run build              # Build to dist/
 *   node scripts/build.js      # Same
 */

import { cpSync, mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

// Files and directories to include in the extension package
const INCLUDE = [
  'manifest.json',
  'background.js',
  'setup.html',
  'setup.js',
  'icon.svg',
  'kyt-memory-injection-builder.js',
  // Directories (copied recursively)
  'src',
  'popup',
  'platforms',
];

console.log('Building KYT extension...');

// Clean previous build
if (existsSync(DIST)) {
  rmSync(DIST, { recursive: true });
}
mkdirSync(DIST, { recursive: true });

// Copy each entry
let fileCount = 0;
for (const entry of INCLUDE) {
  const src = join(ROOT, entry);
  const dest = join(DIST, entry);

  if (!existsSync(src)) {
    console.warn(`  skip: ${entry} (not found)`);
    continue;
  }

  cpSync(src, dest, { recursive: true });
  fileCount++;
  console.log(`  copy: ${entry}`);
}

// Validate manifest.json in dist
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf-8'));
console.log(`\nBuild complete: ${fileCount} entries → dist/`);
console.log(`  Name:    ${manifest.name}`);
console.log(`  Version: ${manifest.version}`);
console.log(`  MV:      ${manifest.manifest_version}`);
