/**
 * MCP tool: push_project_to_notebook
 *
 * Exports K.Y.T. project conversations as NotebookLM sources.
 * Groups by conversation_id, chunks at ~50K chars, tracks for incremental push.
 */

import { addTextSources, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import {
  getNotebookForProject,
  getNotebookMapping,
  saveNotebookMapping,
} from '../lib/notebooklm-config.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { getActiveProjectId } from '../lib/config.js';
import { getSupabaseClient, getUserId } from '../lib/supabase-client.js';

const MAX_CHUNK_CHARS = 50_000;
const MAX_SOURCES_LIMIT = 300;
const WARN_SOURCES_THRESHOLD = 250;

export async function pushProjectToNotebookHandler({
  projectId,
  notebookId,
  maxSources = 50,
  incremental = true,
  passphrase,
}) {
  if (!isAuthConfigured()) {
    return {
      content: [{
        type: 'text',
        text: 'NotebookLM auth not configured. Use the login flow or import cookies first.',
      }],
      isError: true,
    };
  }

  if (passphrase) setPassphrase(passphrase);
  if (!hasPassphrase()) {
    return {
      content: [{
        type: 'text',
        text: 'Auth unavailable. Import cookies first (auto-key handles encryption), or pass `passphrase` to override.',
      }],
      isError: true,
    };
  }

  // Resolve project
  const resolvedProjectId = projectId || getActiveProjectId();
  if (!resolvedProjectId) {
    return {
      content: [{
        type: 'text',
        text: 'Error: No project specified and no active project set. Pass projectId or use set_active_project first.',
      }],
      isError: true,
    };
  }

  // Resolve notebook
  let resolvedNotebookId = notebookId || getNotebookForProject(resolvedProjectId);
  if (!resolvedNotebookId) {
    return {
      content: [{
        type: 'text',
        text: `No notebook linked to project ${resolvedProjectId}. Use create_notebook first.`,
      }],
      isError: true,
    };
  }

  try {
    // Get mapping for incremental tracking
    const mapping = getNotebookMapping(resolvedNotebookId) || {};
    const pushedConvIds = new Set(mapping.pushedConversationIds || []);
    const existingSourceCount = (mapping.sourceIds || []).length;

    // Query chat_turns for this project
    const supabase = getSupabaseClient();
    const userId = getUserId();

    let query = supabase
      .from('chat_turns')
      .select('id, conversation_id, content, platform, created_at, speakers')
      .eq('user_id', userId)
      .eq('project_id', resolvedProjectId)
      .order('conversation_id')
      .order('created_at');

    const { data: turns, error } = await query;
    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    if (!turns || turns.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No chat turns found for project ${resolvedProjectId}.`,
        }],
      };
    }

    // Group by conversation_id
    const conversations = new Map();
    for (const turn of turns) {
      const convId = turn.conversation_id || 'unknown';
      if (!conversations.has(convId)) {
        conversations.set(convId, []);
      }
      conversations.get(convId).push(turn);
    }

    // Filter already-pushed conversations if incremental
    let conversationEntries = Array.from(conversations.entries());
    if (incremental) {
      conversationEntries = conversationEntries.filter(([convId]) => !pushedConvIds.has(convId));
    }

    if (conversationEntries.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `All ${conversations.size} conversations already pushed. Use incremental=false to re-push.`,
        }],
      };
    }

    // Build source chunks
    const sources = [];
    for (const [convId, convTurns] of conversationEntries) {
      const formatted = formatConversation(convTurns);
      const chunks = chunkText(formatted.text, MAX_CHUNK_CHARS);
      const platform = convTurns[0]?.platform || 'unknown';
      const dateRange = formatted.dateRange;

      for (let i = 0; i < chunks.length; i++) {
        const suffix = chunks.length > 1 ? ` (part ${i + 1}/${chunks.length})` : '';
        sources.push({
          title: `${platform} — ${dateRange}${suffix}`,
          content: chunks[i],
          conversationId: convId,
        });
      }
    }

    // Check source limits
    const totalAfterPush = existingSourceCount + sources.length;
    if (totalAfterPush > MAX_SOURCES_LIMIT) {
      return {
        content: [{
          type: 'text',
          text: `Cannot push: would create ${totalAfterPush} sources (limit: ${MAX_SOURCES_LIMIT}). ` +
            `Currently ${existingSourceCount} sources. Reduce maxSources or delete old sources.`,
        }],
        isError: true,
      };
    }

    // Cap at maxSources
    const toUpload = sources.slice(0, maxSources);

    // Upload
    const sourceIds = await addTextSources(resolvedNotebookId, toUpload);

    // Track pushed conversation IDs
    const newPushedConvIds = new Set(toUpload.map(s => s.conversationId));
    const allPushedConvIds = [...pushedConvIds, ...newPushedConvIds];

    // Update mapping
    saveNotebookMapping(resolvedNotebookId, {
      lastPushAt: new Date().toISOString(),
      lastTurnCount: turns.length,
      sourceIds: [...(mapping.sourceIds || []), ...sourceIds.filter(Boolean)],
      pushedConversationIds: [...new Set(allPushedConvIds)],
    });

    const slotsRemaining = MAX_SOURCES_LIMIT - (existingSourceCount + toUpload.length);
    const warnMsg = slotsRemaining <= (MAX_SOURCES_LIMIT - WARN_SOURCES_THRESHOLD)
      ? `\n Warning: ${slotsRemaining} source slots remaining (limit: ${MAX_SOURCES_LIMIT})`
      : '';

    const lines = [
      `Pushed ${toUpload.length} source(s) to notebook ${resolvedNotebookId}`,
      `Conversations: ${newPushedConvIds.size} new, ${pushedConvIds.size} previously pushed`,
      `Turns grouped: ${turns.length} total`,
      `Slots remaining: ${slotsRemaining}/${MAX_SOURCES_LIMIT}${warnMsg}`,
    ];

    if (sources.length > maxSources) {
      lines.push(`\nNote: ${sources.length - maxSources} source(s) skipped (maxSources=${maxSources}). Run again to continue.`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error pushing to notebook: ${err.message}` }],
      isError: true,
    };
  }
}

/**
 * Format a conversation's turns into readable text with speaker labels and timestamps.
 */
function formatConversation(turns) {
  const lines = [];
  let minDate = null;
  let maxDate = null;

  for (const turn of turns) {
    const date = turn.created_at ? new Date(turn.created_at) : null;
    if (date) {
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
    }

    const timestamp = date ? date.toISOString().slice(0, 16).replace('T', ' ') : '';
    const prefix = timestamp ? `[${timestamp}] ` : '';
    lines.push(`${prefix}${turn.content || ''}`);
    lines.push('');
  }

  const fmt = d => d.toISOString().slice(0, 10);
  const dateRange = minDate && maxDate
    ? (fmt(minDate) === fmt(maxDate) ? fmt(minDate) : `${fmt(minDate)} to ${fmt(maxDate)}`)
    : 'unknown date';

  return { text: lines.join('\n'), dateRange };
}

/**
 * Chunk text at approximately maxChars, splitting at paragraph boundaries.
 */
function chunkText(text, maxChars) {
  if (text.length <= maxChars) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Find a paragraph break near maxChars
    let splitAt = remaining.lastIndexOf('\n\n', maxChars);
    if (splitAt < maxChars * 0.5) {
      splitAt = remaining.lastIndexOf('\n', maxChars);
    }
    if (splitAt < maxChars * 0.5) {
      splitAt = maxChars;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}
