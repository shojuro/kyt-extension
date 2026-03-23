/**
 * MCP tool: get_conversation_history
 *
 * Get conversation history from a NotebookLM notebook.
 * Optionally saves to K.Y.T. as research content.
 */

import { getConversationHistory, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { getNotebookForProject, getNotebookMapping } from '../lib/notebooklm-config.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { getActiveProjectId } from '../lib/config.js';
import { callEdgeFunction, getUserId } from '../lib/supabase-client.js';
import { sanitize, wrapWithProvenance } from '../lib/notebooklm-sanitizer.js';

export async function getConversationHistoryHandler({ notebookId, limit = 20, saveToKyt = false, projectId, passphrase }) {
  if (!isAuthConfigured()) {
    return {
      content: [{ type: 'text', text: 'NotebookLM auth not configured. Use the login flow or import cookies first.' }],
      isError: true,
    };
  }

  if (passphrase) setPassphrase(passphrase);
  if (!hasPassphrase()) {
    return {
      content: [{ type: 'text', text: 'Passphrase required. Pass `passphrase` parameter.' }],
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
    const { conversationId, turns } = await getConversationHistory(resolvedNotebookId, limit);

    if (turns.length === 0) {
      return {
        content: [{ type: 'text', text: 'No conversation history found for this notebook.' }],
      };
    }

    const mapping = getNotebookMapping(resolvedNotebookId);
    const notebookTitle = mapping?.title || resolvedNotebookId;

    const lines = [`**Conversation History** (${notebookTitle}, ${turns.length} turns):\n`];
    for (const turn of turns) {
      const sanitizedText = sanitize(turn.text);
      lines.push(`**${turn.role}**: ${sanitizedText}\n`);
    }

    // Save to K.Y.T. if requested
    if (saveToKyt) {
      try {
        const userId = getUserId();
        const content = turns.map(t => `${t.role}: ${sanitize(t.text)}`).join('\n\n');
        const wrapped = wrapWithProvenance(content, notebookTitle);

        await callEdgeFunction('save_chat_turn_batch', {
          userId,
          messages: [{
            content: wrapped,
            platform: 'notebooklm',
            conversationId: `nlm-conv-${resolvedNotebookId}`,
            speakers: ['user', 'assistant'],
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
      content: [{ type: 'text', text: `Error getting conversation history: ${err.message}` }],
      isError: true,
    };
  }
}
