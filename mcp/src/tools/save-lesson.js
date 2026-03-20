/**
 * MCP tool: save_lesson
 *
 * Save a debugging lesson / non-obvious discovery to the K.Y.T. Lessons
 * Learned notebook in NotebookLM. Dual-writes to K.Y.T. memory (Supabase)
 * for cross-platform search AND to NotebookLM for structured querying.
 *
 * This is the "learning" mechanism — Claude Code calls this when it
 * discovers something non-obvious during debugging, and future sessions
 * can query these lessons before starting similar work.
 */

import { addSource, hasPassphrase, setPassphrase } from '../lib/notebooklm-client.js';
import { getLessonsNotebookId } from '../lib/notebooklm-config.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { callEdgeFunction, getUserId } from '../lib/supabase-client.js';
import { getActiveProjectId } from '../lib/config.js';

const CATEGORIES = new Set([
  'api', 'parsing', 'auth', 'config', 'chrome_extension',
  'notebooklm', 'supabase', 'testing', 'performance', 'css',
  'javascript', 'node', 'database', 'networking', 'security', 'other',
]);

export async function saveLessonHandler({ category, error, rootCause, solution, context, tags = [], passphrase }) {
  // Validate required fields
  if (!category || !CATEGORIES.has(category)) {
    return {
      content: [{ type: 'text', text: `Error: category must be one of: ${[...CATEGORIES].join(', ')}` }],
      isError: true,
    };
  }
  if (!error || !solution) {
    return {
      content: [{ type: 'text', text: 'Error: both error and solution are required.' }],
      isError: true,
    };
  }

  // Build structured lesson content
  const title = `[${category}] ${error.substring(0, 80)}`;
  const date = new Date().toISOString().split('T')[0];
  const tagLine = tags.length > 0 ? `**Tags:** ${tags.join(', ')}` : '';

  const lessonContent = [
    `## ${title}`,
    `**Date:** ${date}`,
    `**Category:** ${category}`,
    tagLine,
    '',
    '### Error',
    error,
    '',
    '### Root Cause',
    rootCause || '(not identified)',
    '',
    '### Solution',
    solution,
    '',
    ...(context ? ['### Context', context, ''] : []),
  ].filter(Boolean).join('\n');

  const results = { notebooklm: null, kyt: null };

  // 1. Save to NotebookLM lessons notebook (if configured + auth available)
  const lessonsNotebookId = getLessonsNotebookId();
  if (lessonsNotebookId && isAuthConfigured()) {
    if (passphrase) setPassphrase(passphrase);
    if (hasPassphrase()) {
      try {
        const { sourceId } = await addSource(lessonsNotebookId, {
          type: 'text',
          title,
          content: lessonContent,
        });
        results.notebooklm = { sourceId, notebook: lessonsNotebookId };
      } catch (err) {
        results.notebooklm = { error: err.message };
      }
    } else {
      results.notebooklm = { error: 'passphrase_not_set' };
    }
  } else if (!lessonsNotebookId) {
    results.notebooklm = { error: 'no_lessons_notebook_configured' };
  }

  // 2. Save to K.Y.T. memory (always, if possible)
  try {
    const userId = getUserId();
    if (userId) {
      const activeProjectId = getActiveProjectId();
      await callEdgeFunction('save_chat_turn_batch', {
        userId,
        turns: [{
          content: lessonContent + (tags.length > 0 ? ` [tags: ${tags.join(', ')}]` : ''),
          platform: 'claude-code',
          conversation_id: `lesson-${date}-${Date.now()}`,
          speakers: ['assistant'],
          content_type: 'note',
        }],
        project_id: activeProjectId || undefined,
      });
      results.kyt = { saved: true };
    }
  } catch (err) {
    results.kyt = { error: err.message };
  }

  // Build response
  const lines = [`Lesson saved: **${title}**\n`];

  if (results.notebooklm?.sourceId) {
    lines.push(`NotebookLM: Saved as source ${results.notebooklm.sourceId}`);
  } else if (results.notebooklm?.error) {
    lines.push(`NotebookLM: ${results.notebooklm.error}`);
  }

  if (results.kyt?.saved) {
    lines.push('K.Y.T. Memory: Saved (searchable after embedding)');
  } else if (results.kyt?.error) {
    lines.push(`K.Y.T. Memory: ${results.kyt.error}`);
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}
