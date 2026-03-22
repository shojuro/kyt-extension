/**
 * MCP tool: get_notebook_summary
 *
 * Get an AI-generated summary of a NotebookLM notebook's sources.
 * Optionally saves to K.Y.T. as research content.
 */

import { getNotebookSummary, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { getNotebookForProject, getNotebookMapping } from '../lib/notebooklm-config.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { getActiveProjectId } from '../lib/config.js';
import { callEdgeFunction, getUserId } from '../lib/supabase-client.js';
import { sanitize, wrapWithProvenance } from '../lib/notebooklm-sanitizer.js';

export async function getNotebookSummaryHandler({ notebookId, saveToKyt = false, projectId, passphrase }) {
  if (!isAuthConfigured()) {
    return {
      content: [{ type: 'text', text: 'NotebookLM auth not configured. Use the login flow or import cookies first.' }],
      isError: true,
    };
  }

  if (passphrase) setPassphrase(passphrase);
  if (!hasPassphrase()) {
    return {
      content: [{ type: 'text', text: 'Auth unavailable. Import cookies first (auto-key handles encryption), or pass `passphrase` to override.' }],
      isError: true,
    };
  }

  // Resolve notebook ID
  const resolvedProjectId = projectId || getActiveProjectId();
  const resolvedNotebookId = notebookId || (resolvedProjectId ? getNotebookForProject(resolvedProjectId) : null);

  if (!resolvedNotebookId) {
    return {
      content: [{
        type: 'text',
        text: 'Error: No notebook specified and no notebook linked to active project. Pass notebookId or link a project first.',
      }],
      isError: true,
    };
  }

  try {
    const { summary, topics } = await getNotebookSummary(resolvedNotebookId);

    if (!summary) {
      return {
        content: [{ type: 'text', text: 'Notebook returned no summary. It may have no sources yet.' }],
      };
    }

    const mapping = getNotebookMapping(resolvedNotebookId);
    const notebookTitle = mapping?.title || resolvedNotebookId;
    const sanitizedSummary = sanitize(summary);

    const lines = [`**Notebook Summary** (${notebookTitle}):\n`, sanitizedSummary];

    if (topics.length > 0) {
      lines.push('', '**Topics:**', ...topics.map(t => `- ${t}`));
    }

    // Save to K.Y.T. if requested
    if (saveToKyt) {
      try {
        const userId = getUserId();
        const content = `Summary: ${sanitizedSummary}${topics.length > 0 ? '\n\nTopics: ' + topics.join(', ') : ''}`;
        const wrapped = wrapWithProvenance(content, notebookTitle);

        await callEdgeFunction('save_chat_turn_batch', {
          userId,
          messages: [{
            content: wrapped,
            platform: 'notebooklm',
            conversationId: `nlm-summary-${resolvedNotebookId}`,
            speakers: ['assistant'],
            contentType: 'research',
          }],
          projectId: resolvedProjectId || undefined,
        });
        lines.push('\nSaved to K.Y.T. as research note.');
      } catch (saveErr) {
        lines.push(`\nWarning: Failed to save to K.Y.T.: ${saveErr.message}`);
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error getting notebook summary: ${err.message}` }],
      isError: true,
    };
  }
}
