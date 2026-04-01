#!/usr/bin/env node

/**
 * K.Y.T. SessionEnd Hook
 *
 * Fires when a Claude Code session terminates.
 * Reads the session info from stdin JSON, finds the session JSONL file,
 * parses it, and ingests text content into K.Y.T. via save_chat_turn_batch.
 *
 * Non-blocking: errors are logged to stderr but never prevent session exit.
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// --- Inline helpers (avoid heavy imports for speed) ---

function getMemoryMode() {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.kyt', 'config.json'), 'utf-8'));
    return config.memoryMode || 'full';
  } catch {
    return 'full';
  }
}

function loadEnv() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const mcpDir = join(scriptDir, '..', '..');

  const envPaths = [
    join(mcpDir, '.env'),                    // mcp/.env (relative to this script)
    join(process.cwd(), 'mcp', '.env'),
    join(process.cwd(), '.env'),
    join(homedir(), '.kyt', '.env'),
  ];
  if (process.env.CLAUDE_PROJECT_DIR) {
    envPaths.unshift(join(process.env.CLAUDE_PROJECT_DIR, 'mcp', '.env'));
  }
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
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

function markSessionIngested(sessionId, count) {
  const kytDir = join(homedir(), '.kyt');
  if (!existsSync(kytDir)) mkdirSync(kytDir, { recursive: true });
  const path = join(kytDir, 'ingested-sessions.json');
  const ingested = getIngestedSessions();
  ingested[sessionId] = { lastIngestedCount: count, ingestedAt: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(ingested, null, 2) + '\n');
}

// Inline memorability filter (avoids heavy import for hook speed)
function isUnmemorable(turn) {
  const c = (turn.content || '').trim();
  if (c.length < 15) return true;
  if (/^(?:yes|no|ok|okay|sure|thanks|correct|exactly|right|continue|proceed|next|good|great|fine|perfect|agreed|noted|understood|got\s*it|sounds?\s*good|let'?s\s*(?:do|go|proceed|continue))[\s.!?]*$/i.test(c)) return true;
  if (turn.role === 'assistant' && /^(?:Done\.?|Ok\.?|Got it\.?|Fixed\.?|Updated\.?|Sure\.?|Understood\.?|Will do\.?)$/i.test(c)) return true;
  if (/^(?:fix|change|update|look\s+at|check)\s+.*(?:line\s*\d+|\.(?:js|ts|py|css|html|json)(?::\d+)?)[\s.!?]*$/i.test(c)) return true;
  // Code-only blocks
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

    turns.push({
      role,
      content,
      timestamp: entry.timestamp || new Date().toISOString(),
    });
  }

  return turns;
}

function debugLog(msg) {
  const logPath = join(homedir(), '.kyt', 'session-hook-debug.log');
  const kytDir = join(homedir(), '.kyt');
  if (!existsSync(kytDir)) mkdirSync(kytDir, { recursive: true });
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try { writeFileSync(logPath, line, { flag: 'a' }); } catch {}
}

async function main() {
  debugLog('SessionEnd hook fired');
  let input;
  try {
    const raw = readFileSync(0, 'utf-8');
    debugLog(`stdin received: ${raw.length} bytes`);
    input = JSON.parse(raw);
    debugLog(`parsed: session_id=${input.session_id}, transcript_path=${input.transcript_path}`);
  } catch (err) {
    debugLog(`stdin parse FAILED: ${err.message}`);
    process.stderr.write(`KYT session-ingest: failed to parse stdin: ${err.message}\n`);
    process.exit(0);
  }

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;

  if (!sessionId || !transcriptPath) {
    debugLog('SKIP: missing session_id or transcript_path');
    process.stderr.write('KYT session-ingest: missing session_id or transcript_path\n');
    process.exit(0);
  }

  // Check memory mode
  const mode = getMemoryMode();
  if (mode === 'incognito') {
    debugLog('SKIP: incognito mode');
    process.stderr.write('KYT session-ingest: incognito mode, skipping\n');
    process.exit(0);
  }

  // Check if transcript file exists
  if (!existsSync(transcriptPath)) {
    debugLog(`SKIP: transcript not found: ${transcriptPath}`);
    process.stderr.write(`KYT session-ingest: transcript not found: ${transcriptPath}\n`);
    process.exit(0);
  }

  loadEnv();

  const supabaseUrl = process.env.SUPABASE_URL;
  const token = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  const userId = process.env.KYT_USER_ID;

  if (!supabaseUrl || !token || !userId) {
    debugLog(`SKIP: missing env vars (url=${!!supabaseUrl}, token=${!!token}, userId=${!!userId})`);
    process.stderr.write('KYT session-ingest: missing env vars\n');
    process.exit(0);
  }

  try {
    // Parse the session
    const turns = parseSessionJsonl(transcriptPath);
    if (turns.length === 0) {
      process.stderr.write(`KYT session-ingest: no text content in session ${sessionId}\n`);
      process.exit(0);
    }

    // Check incremental progress
    const ingested = getIngestedSessions();
    const lastCount = ingested[sessionId]?.lastIngestedCount || 0;
    const newTurns = turns.slice(lastCount);

    if (newTurns.length === 0) {
      process.stderr.write(`KYT session-ingest: session ${sessionId} already fully ingested\n`);
      process.exit(0);
    }

    // Filter out unmemorable turns (noise reduction)
    const memorableTurns = newTurns.filter(t => !isUnmemorable(t));
    const filteredCount = newTurns.length - memorableTurns.length;
    if (filteredCount > 0) {
      process.stderr.write(`KYT session-ingest: filtered ${filteredCount} unmemorable turns\n`);
    }

    if (memorableTurns.length === 0) {
      markSessionIngested(sessionId, lastCount + newTurns.length);
      process.stderr.write(`KYT session-ingest: ${sessionId} — all ${newTurns.length} new turns filtered as unmemorable\n`);
      process.exit(0);
    }

    // Batch send to save_chat_turn_batch (max 50 per batch)
    const BATCH_SIZE = 50;
    const HOOK_DEADLINE = Date.now() + 50000; // 50s hard deadline (60s hook timeout - 10s headroom)
    const FETCH_TIMEOUT_MS = 15000; // 15s per batch fetch
    let totalInserted = 0;
    let lastBatchEnd = 0; // Track how far we actually got
    const conversationId = `cc-${sessionId}`;

    for (let i = 0; i < memorableTurns.length; i += BATCH_SIZE) {
      // Deadline check: abort gracefully before Claude Code kills us
      const remaining = HOOK_DEADLINE - Date.now();
      if (remaining < 5000) {
        debugLog(`TIMEOUT: Aborting with ${memorableTurns.length - i} turns remaining (deadline approaching)`);
        break;
      }

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
        const controller = new AbortController();
        const fetchTimeout = setTimeout(() => controller.abort(), Math.min(FETCH_TIMEOUT_MS, remaining));

        const res = await fetch(`${supabaseUrl}/functions/v1/save_chat_turn_batch`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
            'apikey': process.env.SUPABASE_ANON_KEY || token,
          },
          body: JSON.stringify({ turns: batch, skip_ai_processing: false }),
          signal: controller.signal,
        });
        clearTimeout(fetchTimeout);

        if (res.ok) {
          const result = await res.json();
          totalInserted += result.inserted || 0;
        }
      } catch (fetchErr) {
        if (fetchErr.name === 'AbortError') {
          debugLog(`TIMEOUT: Batch ${Math.floor(i / BATCH_SIZE) + 1} timed out after ${FETCH_TIMEOUT_MS}ms`);
          break; // Save progress so far, don't retry
        }
        debugLog(`FETCH_ERROR: Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${fetchErr.message}`);
        // Continue to next batch — one failure shouldn't block others
      }

      lastBatchEnd = i + batch.length;
    }

    // Track progress (even partial — hook can resume from here next session)
    const actuallyProcessed = lastBatchEnd || memorableTurns.length;
    markSessionIngested(sessionId, lastCount + actuallyProcessed);
    const summary = `${sessionId} — ${newTurns.length} new, ${filteredCount} filtered, ${memorableTurns.length} memorable, ${totalInserted} inserted`;
    debugLog(`SUCCESS: ${summary}`);
    process.stderr.write(`KYT session-ingest: ${summary}\n`);

  } catch (err) {
    debugLog(`ERROR: ${err.message}`);
    process.stderr.write(`KYT session-ingest: ${err.message}\n`);
  }

  process.exit(0);
}

main();
