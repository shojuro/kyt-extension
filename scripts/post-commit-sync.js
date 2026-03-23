#!/usr/bin/env node
/**
 * Post-Commit Notebook Sync
 *
 * Automatically syncs code changes to the K.Y.T. Codebase Index notebook
 * after each git commit. Designed to run as a Claude Code PostToolUse hook.
 *
 * What it does:
 * 1. Detects files changed in the last commit (git diff HEAD~1)
 * 2. Filters to trackable files (.js, .ts, .sql)
 * 3. Pushes changed files as sources to the Codebase Index notebook
 * 4. Deletes stale versions of refreshed files
 *
 * Usage:
 *   node scripts/post-commit-sync.js              # Auto-detect last commit
 *   node scripts/post-commit-sync.js --dry-run    # Show what would be pushed
 *   node scripts/post-commit-sync.js --commit abc123  # Specific commit
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Load .env
const envPath = resolve(__dirname, '../mcp/.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
} catch { /* no .env */ }

// Notebook IDs
const CODEBASE_INDEX_NB = '93685862-3951-48e7-95cc-1c2c12b33b27';
const MAX_SOURCE_SIZE = 45000;

// File extensions we track in the notebook
const TRACKED_EXTENSIONS = new Set(['.js', '.ts', '.sql', '.json']);

// Files to always skip
const SKIP_PATTERNS = [
  /node_modules/,
  /\.test\./,
  /test-.*\.js$/,
  /\.config\./,
  /package-lock/,
  /synthetic-conversations/,
  /\.env/,
];

// Parse args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const commitIdx = args.indexOf('--commit');
const specificCommit = commitIdx !== -1 ? args[commitIdx + 1] : null;

async function getChangedFiles() {
  try {
    const diffCmd = specificCommit
      ? `git diff --name-status ${specificCommit}~1 ${specificCommit}`
      : 'git diff --name-status HEAD~1 HEAD';

    const output = execSync(diffCmd, { cwd: ROOT, encoding: 'utf-8' }).trim();
    if (!output) return { added: [], modified: [], deleted: [] };

    const added = [];
    const modified = [];
    const deleted = [];

    for (const line of output.split('\n')) {
      const [status, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t'); // Handle paths with tabs (unlikely but safe)

      if (!filePath) continue;

      // Check extension
      const ext = '.' + filePath.split('.').pop();
      if (!TRACKED_EXTENSIONS.has(ext)) continue;

      // Check skip patterns
      if (SKIP_PATTERNS.some(p => p.test(filePath))) continue;

      if (status === 'A') added.push(filePath);
      else if (status === 'M') modified.push(filePath);
      else if (status === 'D') deleted.push(filePath);
    }

    return { added, modified, deleted };
  } catch (e) {
    console.error('[post-commit-sync] Failed to get changed files:', e.message);
    return { added: [], modified: [], deleted: [] };
  }
}

function getCommitInfo() {
  try {
    const hash = execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
    const msg = execSync('git log -1 --pretty=format:%s', { cwd: ROOT, encoding: 'utf-8' }).trim();
    return { hash, msg };
  } catch {
    return { hash: 'unknown', msg: 'unknown' };
  }
}

async function main() {
  const { added, modified, deleted } = await getChangedFiles();
  const commit = getCommitInfo();

  const toAdd = [...added, ...modified]; // Both new and modified files get pushed
  const toDelete = deleted;

  if (toAdd.length === 0 && toDelete.length === 0) {
    console.log('[post-commit-sync] No trackable files changed in commit', commit.hash);
    return;
  }

  console.log(`[post-commit-sync] Commit ${commit.hash}: ${commit.msg}`);
  console.log(`  Files: +${added.length} added, ~${modified.length} modified, -${deleted.length} deleted`);

  if (DRY_RUN) {
    console.log('\n  DRY RUN — would push:');
    for (const f of toAdd) console.log('    +', f);
    for (const f of toDelete) console.log('    -', f);
    return;
  }

  // Dynamic import of NLM client (only when actually pushing)
  const clientPath = resolve(__dirname, '../mcp/src/lib/notebooklm-client.js');
  const { addTextSource, listSources, deleteSource } = await import(clientPath);

  // Get existing sources to find ones to refresh/delete
  let existingSources;
  try {
    existingSources = await listSources(CODEBASE_INDEX_NB);
  } catch (e) {
    console.error('[post-commit-sync] Failed to list sources:', e.message);
    console.log('[post-commit-sync] Skipping sync (NLM unavailable)');
    return;
  }

  const sourceByTitle = new Map(existingSources.map(s => [s.title, s.id]));

  let pushed = 0;
  let refreshed = 0;
  let errors = 0;

  // Push added/modified files
  for (const filePath of toAdd) {
    const fullPath = resolve(ROOT, filePath);
    if (!existsSync(fullPath)) continue;

    let content = readFileSync(fullPath, 'utf-8');
    if (content.length > MAX_SOURCE_SIZE) {
      content = content.substring(0, MAX_SOURCE_SIZE) + '\n\n// [TRUNCATED at 45KB for NotebookLM source limit]';
    }

    try {
      // Delete stale version if exists
      const existingId = sourceByTitle.get(filePath);
      if (existingId) {
        try {
          await deleteSource(CODEBASE_INDEX_NB, existingId);
          refreshed++;
        } catch { /* ignore */ }
      }

      await addTextSource(CODEBASE_INDEX_NB, filePath, content);
      pushed++;
      console.log(`  ${existingId ? '~' : '+'} ${filePath}`);

      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      errors++;
      console.warn(`  ! ${filePath}: ${e.message.substring(0, 60)}`);
    }
  }

  // Delete removed files from notebook
  for (const filePath of toDelete) {
    const existingId = sourceByTitle.get(filePath);
    if (existingId) {
      try {
        await deleteSource(CODEBASE_INDEX_NB, existingId);
        console.log(`  - ${filePath}`);
      } catch { /* ignore */ }
    }
  }

  console.log(`[post-commit-sync] Done: ${pushed} pushed, ${refreshed} refreshed, ${errors} errors`);
}

main().catch(e => {
  console.error('[post-commit-sync] Fatal:', e.message);
  // Non-fatal — don't block the commit workflow
  process.exit(0);
});
