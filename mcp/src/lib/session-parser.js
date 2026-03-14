import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CLAUDE_DIR = join(homedir(), '.claude');

export function findProjectDir() {
  const projectsDir = join(CLAUDE_DIR, 'projects');
  if (!existsSync(projectsDir)) return null;

  const dirs = readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => join(projectsDir, d.name));

  return dirs.length > 0 ? dirs : null;
}

export function getSessionIndex(projectDir) {
  const indexPath = join(projectDir, 'sessions-index.json');
  if (!existsSync(indexPath)) return [];

  try {
    const raw = readFileSync(indexPath, 'utf-8');
    const parsed = JSON.parse(raw);
    // Format: { version: 1, entries: [...] }
    if (parsed.entries && Array.isArray(parsed.entries)) return parsed.entries;
    // Or bare array
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

export function parseSessionFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`Session file not found: ${filePath}`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const turns = [];

  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    // Skip non-message entries
    if (entry.type === 'file-history-snapshot') continue;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;

    const msg = entry.message;
    if (!msg) continue;

    const role = msg.role || entry.type;
    const content = extractTextContent(msg.content);

    if (!content || content.trim().length === 0) continue;

    turns.push({
      role,
      content,
      timestamp: entry.timestamp || new Date().toISOString(),
      sessionId: entry.sessionId,
    });
  }

  return turns;
}

function extractWrittenContent(block) {
  if (block.type !== 'tool_use') return null;
  const name = block.name;
  const input = block.input || {};

  // Write tool: capture full content written to .md files
  if (name === 'Write' && input.file_path && input.content) {
    if (input.file_path.endsWith('.md')) {
      const filename = input.file_path.split('/').pop();
      return `[Written to ${filename}]\n${input.content}`;
    }
  }

  // Edit tool: capture new_string for .md file edits
  if (name === 'Edit' && input.file_path && input.new_string) {
    if (input.file_path.endsWith('.md')) {
      const filename = input.file_path.split('/').pop();
      return `[Edited ${filename}]\n${input.new_string}`;
    }
  }

  return null;
}

function extractTextContent(content) {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        parts.push(block.text);
      } else {
        const written = extractWrittenContent(block);
        if (written) parts.push(written);
      }
    }
    return parts.join('\n').trim();
  }

  return '';
}

export function findSessionFile(projectDir, sessionId) {
  // Check if index has a fullPath for this session
  const index = getSessionIndex(projectDir);
  const indexEntry = index.find(e => e.sessionId === sessionId);
  if (indexEntry?.fullPath && existsSync(indexEntry.fullPath)) {
    return indexEntry.fullPath;
  }

  // Session files are named by UUID
  const direct = join(projectDir, `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;

  return null;
}

export function getMostRecentSession(projectDir) {
  // First try: scan actual .jsonl files on disk (catches active sessions not in index)
  const newestFile = scanForNewestJsonl(projectDir);

  // Also check the index
  const index = getSessionIndex(projectDir);
  let newestIndexEntry = null;
  if (index.length > 0) {
    const sorted = [...index].sort((a, b) => {
      const dateA = new Date(a.modified || a.created || 0);
      const dateB = new Date(b.modified || b.created || 0);
      return dateB - dateA;
    });
    newestIndexEntry = sorted[0];
  }

  // Compare: pick whichever is more recent
  if (newestFile && newestIndexEntry) {
    const fileMtime = newestFile.modified ? new Date(newestFile.modified) : new Date(0);
    const indexMtime = new Date(newestIndexEntry.modified || newestIndexEntry.created || 0);
    return fileMtime > indexMtime ? newestFile : newestIndexEntry;
  }

  return newestFile || newestIndexEntry || null;
}

function scanForNewestJsonl(projectDir) {
  try {
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'));

    if (files.length === 0) return null;

    let newest = null;
    let newestMtime = 0;

    for (const file of files) {
      const fullPath = join(projectDir, file);
      const stat = statSync(fullPath);
      if (stat.mtimeMs > newestMtime) {
        newestMtime = stat.mtimeMs;
        newest = {
          sessionId: file.replace('.jsonl', ''),
          fullPath,
          modified: stat.mtime.toISOString(),
        };
      }
    }

    return newest;
  } catch {
    return null;
  }
}
