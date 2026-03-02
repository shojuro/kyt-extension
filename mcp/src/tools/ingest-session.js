import { callEdgeFunction, getUserId } from '../lib/supabase-client.js';
import { getMemoryMode } from '../lib/config.js';
import {
  findProjectDir,
  getSessionIndex,
  parseSessionFile,
  findSessionFile,
  getMostRecentSession,
} from '../lib/session-parser.js';
import { getIngestedSessions, markSessionIngested } from '../lib/config.js';
import { filterForMemorability } from '../lib/memorability-filter.js';

export const INGEST_SESSION_SCHEMA = {
  sessionId: {
    type: 'string',
    description: 'Session ID to ingest (defaults to most recent session)',
  },
  all: {
    type: 'boolean',
    description: 'Ingest all un-ingested sessions (default: false)',
  },
  force: {
    type: 'boolean',
    description: 'Force re-ingestion of a session (resets ingested count to 0)',
  },
};

export async function ingestSession({ sessionId, all = false, force = false }) {
  const mode = getMemoryMode();
  if (mode === 'incognito') {
    return {
      content: [{ type: 'text', text: 'Memory mode is "incognito" — ingestion blocked.' }],
    };
  }

  const projectDirs = findProjectDir();
  if (!projectDirs || projectDirs.length === 0) {
    return {
      content: [{ type: 'text', text: 'No Claude Code project directories found in ~/.claude/projects/' }],
      isError: true,
    };
  }

  if (all) {
    return ingestAllSessions(projectDirs, force);
  }

  // Find the target session
  for (const dir of projectDirs) {
    if (sessionId) {
      const filePath = findSessionFile(dir, sessionId);
      if (filePath) {
        return ingestOneSession(filePath, sessionId, force);
      }
    } else {
      const recent = getMostRecentSession(dir);
      if (recent) {
        const filePath = findSessionFile(dir, recent.sessionId);
        if (filePath) {
          return ingestOneSession(filePath, recent.sessionId, force);
        }
      }
    }
  }

  return {
    content: [{
      type: 'text',
      text: sessionId
        ? `Session "${sessionId}" not found in any project directory.`
        : 'No sessions found to ingest.',
    }],
    isError: true,
  };
}

async function ingestOneSession(filePath, sessionId, force = false) {
  const ingested = getIngestedSessions();
  const lastCount = force ? 0 : (ingested[sessionId]?.lastIngestedCount || 0);

  const turns = parseSessionFile(filePath);

  if (turns.length === 0) {
    return {
      content: [{ type: 'text', text: `Session ${sessionId}: no text content found (all tool_use/thinking).` }],
    };
  }

  // Only process turns after the last-ingested count (incremental)
  const newTurns = turns.slice(lastCount);

  if (newTurns.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `Session ${sessionId}: already fully ingested (${lastCount} turns).`,
      }],
    };
  }

  // Filter out unmemorable turns (noise reduction)
  const { kept: memorableTurns, filtered: filteredCount } = filterForMemorability(newTurns);

  if (memorableTurns.length === 0) {
    // Track progress even when all turns are filtered
    markSessionIngested(sessionId, lastCount + newTurns.length);
    return {
      content: [{
        type: 'text',
        text: `Session ${sessionId}: ${newTurns.length} new turns parsed, all filtered as unmemorable.`,
      }],
    };
  }

  const userId = getUserId();
  const conversationId = `cc-${sessionId}`;

  // Batch into groups of 50 (edge function limit)
  const BATCH_SIZE = 50;
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;

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
      const result = await callEdgeFunction('save_chat_turn_batch', {
        turns: batch,
        skip_ai_processing: false,
      });

      if (result.error) {
        totalErrors++;
      } else {
        totalInserted += result.inserted || 0;
        totalDuplicates += result.duplicates_skipped || 0;
      }
    } catch {
      totalErrors++;
    }
  }

  // Track ingestion progress
  markSessionIngested(sessionId, lastCount + newTurns.length);

  return {
    content: [{
      type: 'text',
      text: [
        `Session ${sessionId} ingested:`,
        `  Turns parsed: ${newTurns.length}`,
        `  Filtered (unmemorable): ${filteredCount}`,
        `  Memorable turns processed: ${memorableTurns.length}`,
        `  Inserted: ${totalInserted}`,
        `  Duplicates skipped: ${totalDuplicates}`,
        totalErrors > 0 ? `  Batch errors: ${totalErrors}` : null,
        `  Total turns tracked: ${lastCount + newTurns.length}`,
      ].filter(Boolean).join('\n'),
    }],
  };
}

async function ingestAllSessions(projectDirs, force = false) {
  const ingested = getIngestedSessions();
  let sessionsProcessed = 0;
  let totalInserted = 0;
  let totalErrors = 0;

  for (const dir of projectDirs) {
    // Discover sessions from both the index AND by scanning for .jsonl files
    const index = getSessionIndex(dir);
    const indexSids = new Set(index.map(s => s.sessionId));

    // Scan for .jsonl files not in the index
    let dirFiles = [];
    try {
      const { readdirSync } = await import('fs');
      dirFiles = readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace('.jsonl', ''));
    } catch { /* ignore */ }

    // Merge: index entries + discovered files
    const allSids = new Set([...indexSids, ...dirFiles]);

    for (const sid of allSids) {
      const indexEntry = index.find(s => s.sessionId === sid);
      const lastCount = ingested[sid]?.lastIngestedCount || 0;
      const currentCount = indexEntry?.messageCount || 0;

      // Skip if already fully ingested (unless force)
      if (!force && currentCount > 0 && lastCount >= currentCount) continue;
      if (!force && lastCount > 0 && currentCount === 0) continue; // no index entry, already ingested

      const filePath = findSessionFile(dir, sid);
      if (!filePath) continue;

      try {
        const result = await ingestOneSession(filePath, sid, force);
        sessionsProcessed++;

        const match = result.content[0]?.text?.match(/Inserted: (\d+)/);
        if (match) totalInserted += parseInt(match[1], 10);
      } catch (err) {
        totalErrors++;
        process.stderr?.write?.(`ingestAll: ${sid} failed: ${err.message}\n`);
      }
    }
  }

  return {
    content: [{
      type: 'text',
      text: [
        sessionsProcessed > 0
          ? `Batch ingestion complete: ${sessionsProcessed} sessions, ${totalInserted} inserted.`
          : 'All sessions already ingested — nothing new to process.',
        totalErrors > 0 ? `${totalErrors} sessions failed (see stderr).` : null,
      ].filter(Boolean).join('\n'),
    }],
  };
}
