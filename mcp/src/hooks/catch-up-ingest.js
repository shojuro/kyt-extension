#!/usr/bin/env node

/**
 * K.Y.T. Catch-Up Ingestion
 *
 * Scans for session JSONL files that were missed by SessionEnd hook
 * (e.g. terminal closed, WSL shutdown, kill -9).
 * Spawned as a detached background process by prompt-inject.js.
 *
 * Skips the currently active session (passed as CLI arg).
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const LOG_PATH = join(homedir(), '.kyt', 'catch-up.log');

function log(msg) {
  const kytDir = join(homedir(), '.kyt');
  if (!existsSync(kytDir)) mkdirSync(kytDir, { recursive: true });
  const ts = new Date().toISOString();
  try { writeFileSync(LOG_PATH, `[${ts}] ${msg}\n`, { flag: 'a' }); } catch {}
}

function loadEnv() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const mcpDir = join(scriptDir, '..', '..');
  const envPaths = [
    join(mcpDir, '.env'),
    join(homedir(), '.kyt', '.env'),
  ];
  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const lines = readFileSync(envPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = value;
      }
      break;
    }
  }
}

function getIngestedSessions() {
  const path = join(homedir(), '.kyt', 'ingested-sessions.json');
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return {}; }
}

function markSessionIngested(sessionId, count) {
  const kytDir = join(homedir(), '.kyt');
  if (!existsSync(kytDir)) mkdirSync(kytDir, { recursive: true });
  const path = join(kytDir, 'ingested-sessions.json');
  const ingested = getIngestedSessions();
  ingested[sessionId] = { lastIngestedCount: count, ingestedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(ingested, null, 2) + '\n');
}

function isUnmemorable(turn) {
  const c = (turn.content || '').trim();
  if (c.length < 15) return true;
  if (/^(?:yes|no|ok|okay|sure|thanks|correct|exactly|right|continue|proceed|next|good|great|fine|perfect|agreed|noted|understood|got\s*it|sounds?\s*good|let'?s\s*(?:do|go|proceed|continue))[\s.!?]*$/i.test(c)) return true;
  if (turn.role === 'assistant' && /^(?:Done\.?|Ok\.?|Got it\.?|Fixed\.?|Updated\.?|Sure\.?|Understood\.?|Will do\.?)$/i.test(c)) return true;
  if (/^(?:fix|change|update|look\s+at|check)\s+.*(?:line\s*\d+|\.(?:js|ts|py|css|html|json)(?::\d+)?)[\s.!?]*$/i.test(c)) return true;
  const withoutCode = c.replace(/```[\s\S]*?```/g, '').trim();
  if (c.includes('```') && withoutCode.length < 20) return true;
  return false;
}

function parseSessionJsonl(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const turns = [];
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === 'file-history-snapshot') continue;
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    const msg = entry.message;
    if (!msg) continue;
    const role = msg.role || entry.type;
    let content;
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      const parts = [];
      for (const b of msg.content) {
        if (b.type === 'text' && b.text) {
          parts.push(b.text);
        } else if (b.type === 'tool_use') {
          const inp = b.input || {};
          if (b.name === 'Write' && inp.file_path?.endsWith('.md') && inp.content) {
            parts.push(`[Written to ${inp.file_path.split('/').pop()}]\n${inp.content}`);
          } else if (b.name === 'Edit' && inp.file_path?.endsWith('.md') && inp.new_string) {
            parts.push(`[Edited ${inp.file_path.split('/').pop()}]\n${inp.new_string}`);
          }
        }
      }
      content = parts.join('\n').trim();
    }
    if (!content || content.trim().length === 0) continue;
    turns.push({ role, content, timestamp: entry.timestamp || new Date().toISOString() });
  }
  return turns;
}

async function main() {
  const activeSessionId = process.argv[2] || '';

  loadEnv();
  const supabaseUrl = process.env.SUPABASE_URL;
  const token = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  const userId = process.env.KYT_USER_ID;

  if (!supabaseUrl || !token || !userId) {
    log('SKIP: missing env vars');
    process.exit(0);
  }

  // Find all session directories
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) {
    log('SKIP: no projects dir');
    process.exit(0);
  }

  const ingested = getIngestedSessions();
  const sessionFiles = [];

  // Scan all project directories for .jsonl files
  for (const projDir of readdirSync(projectsDir)) {
    const projPath = join(projectsDir, projDir);
    try {
      const stat = statSync(projPath);
      if (!stat.isDirectory()) continue;
    } catch { continue; }

    for (const file of readdirSync(projPath)) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.replace('.jsonl', '');
      // Skip active session, already-ingested, and subagent files
      if (sessionId === activeSessionId) continue;
      if (ingested[sessionId]) continue;
      if (file.includes('subagent')) continue;

      const filePath = join(projPath, file);
      try {
        const stat = statSync(filePath);
        // Skip tiny files (<500 bytes — likely empty sessions)
        if (stat.size < 500) continue;
        // Skip files modified in the last 60 seconds (might still be active)
        if (Date.now() - stat.mtimeMs < 60000) continue;
        sessionFiles.push({ sessionId, filePath, size: stat.size });
      } catch { continue; }
    }
  }

  if (sessionFiles.length === 0) {
    log('No missed sessions found');
    process.exit(0);
  }

  log(`Found ${sessionFiles.length} un-ingested sessions`);

  let totalIngested = 0;
  for (const { sessionId, filePath } of sessionFiles) {
    try {
      const turns = parseSessionJsonl(filePath);
      if (turns.length === 0) {
        markSessionIngested(sessionId, 0);
        continue;
      }

      const memorableTurns = turns.filter(t => !isUnmemorable(t));
      if (memorableTurns.length === 0) {
        markSessionIngested(sessionId, turns.length);
        log(`${sessionId.slice(0, 12)}: ${turns.length} turns, all unmemorable`);
        continue;
      }

      // Batch send
      const BATCH_SIZE = 50;
      let inserted = 0;
      const conversationId = `cc-${sessionId}`;

      for (let i = 0; i < memorableTurns.length; i += BATCH_SIZE) {
        const batch = memorableTurns.slice(i, i + BATCH_SIZE).map(t => ({
          user_id: userId,
          conversation_id: conversationId,
          platform: 'claude-code',
          content: t.content,
          role: t.role,
          timestamp: t.timestamp,
          is_injection: false,
          content_type: 'imported',
        }));

        try {
          const res = await fetch(`${supabaseUrl}/functions/v1/save_chat_turn_batch`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
              'apikey': process.env.SUPABASE_ANON_KEY || token,
            },
            body: JSON.stringify({ turns: batch, skip_ai_processing: false }),
          });

          if (res.ok) {
            const result = await res.json();
            inserted += result.inserted || 0;
          }
        } catch (err) {
          log(`${sessionId.slice(0, 12)}: batch error: ${err.message}`);
        }
      }

      markSessionIngested(sessionId, turns.length);
      totalIngested += inserted;
      log(`${sessionId.slice(0, 12)}: ${memorableTurns.length} memorable, ${inserted} inserted`);
    } catch (err) {
      log(`${sessionId.slice(0, 12)}: FAILED: ${err.message}`);
    }
  }

  log(`Catch-up complete: ${sessionFiles.length} sessions, ${totalIngested} total inserted`);

  // Clean up old catch-up flag files (keep only current session's)
  try {
    const kytDir = join(homedir(), '.kyt');
    for (const file of readdirSync(kytDir)) {
      if (file.startsWith('catch-up-') && file.endsWith('.flag')) {
        const flagPath = join(kytDir, file);
        const stat = statSync(flagPath);
        // Remove flags older than 24 hours
        if (Date.now() - stat.mtimeMs > 86400000) {
          try { unlinkSync(flagPath); } catch {}
        }
      }
    }
  } catch { /* non-critical */ }

  process.exit(0);
}

main();
