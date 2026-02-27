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

export const INGEST_SESSION_SCHEMA = {
  sessionId: {
    type: 'string',
    description: 'Session ID to ingest (defaults to most recent session)',
  },
  all: {
    type: 'boolean',
    description: 'Ingest all un-ingested sessions (default: false)',
  },
};

export async function ingestSession({ sessionId, all = false }) {
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
    return ingestAllSessions(projectDirs);
  }

  // Find the target session
  for (const dir of projectDirs) {
    if (sessionId) {
      const filePath = findSessionFile(dir, sessionId);
      if (filePath) {
        return ingestOneSession(filePath, sessionId);
      }
    } else {
      const recent = getMostRecentSession(dir);
      if (recent) {
        const filePath = findSessionFile(dir, recent.sessionId);
        if (filePath) {
          return ingestOneSession(filePath, recent.sessionId);
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

async function ingestOneSession(filePath, sessionId) {
  const ingested = getIngestedSessions();
  const lastCount = ingested[sessionId]?.lastIngestedCount || 0;

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

  const userId = getUserId();
  const conversationId = `cc-${sessionId}`;

  // Batch into groups of 50 (edge function limit)
  const BATCH_SIZE = 50;
  let totalInserted = 0;
  let totalDuplicates = 0;
  let totalErrors = 0;

  for (let i = 0; i < newTurns.length; i += BATCH_SIZE) {
    const batch = newTurns.slice(i, i + BATCH_SIZE).map(t => ({
      user_id: userId,
      conversation_id: conversationId,
      platform: 'claude-code',
      content: t.content,
      role: t.role,
      timestamp: t.timestamp,
      is_injection: false,
      content_type: 'imported',
    }));

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
  }

  // Track ingestion progress
  markSessionIngested(sessionId, lastCount + newTurns.length);

  return {
    content: [{
      type: 'text',
      text: [
        `Session ${sessionId} ingested:`,
        `  New turns processed: ${newTurns.length}`,
        `  Inserted: ${totalInserted}`,
        `  Duplicates skipped: ${totalDuplicates}`,
        totalErrors > 0 ? `  Batch errors: ${totalErrors}` : null,
        `  Total turns tracked: ${lastCount + newTurns.length}`,
      ].filter(Boolean).join('\n'),
    }],
  };
}

async function ingestAllSessions(projectDirs) {
  const ingested = getIngestedSessions();
  let sessionsProcessed = 0;
  let totalNewTurns = 0;

  for (const dir of projectDirs) {
    const index = getSessionIndex(dir);

    for (const session of index) {
      const sid = session.sessionId;
      const lastCount = ingested[sid]?.lastIngestedCount || 0;
      const currentCount = session.messageCount || 0;

      // Skip if already fully ingested
      if (lastCount >= currentCount) continue;

      const filePath = findSessionFile(dir, sid);
      if (!filePath) continue;

      const result = await ingestOneSession(filePath, sid);
      sessionsProcessed++;

      // Extract inserted count from result text
      const match = result.content[0]?.text?.match(/New turns processed: (\d+)/);
      if (match) totalNewTurns += parseInt(match[1], 10);
    }
  }

  return {
    content: [{
      type: 'text',
      text: sessionsProcessed > 0
        ? `Batch ingestion complete: ${sessionsProcessed} sessions, ${totalNewTurns} new turns.`
        : 'All sessions already ingested — nothing new to process.',
    }],
  };
}
