/**
 * MCP tool: generate_mind_map
 *
 * Generate a mind map from selected sources in a NotebookLM notebook.
 */

import { generateMindMap, listSources, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function generateMindMapHandler({ notebookId, sourceIds, passphrase }) {
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

  if (!notebookId) {
    return { content: [{ type: 'text', text: 'Error: notebookId is required.' }], isError: true };
  }

  try {
    // If no sourceIds, use all sources
    let resolvedSourceIds = sourceIds;
    if (!resolvedSourceIds || resolvedSourceIds.length === 0) {
      const sources = await listSources(notebookId);
      resolvedSourceIds = sources.map(s => s.id);
      if (resolvedSourceIds.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: Notebook has no sources. Add sources before generating a mind map.' }],
          isError: true,
        };
      }
    }

    const { taskId } = await generateMindMap(notebookId, resolvedSourceIds);

    return {
      content: [{
        type: 'text',
        text: `Mind map generation started.\nTask ID: ${taskId || '(unknown)'}\nSources: ${resolvedSourceIds.length}\n\nUse list_notebook_notes to see the result once it's ready.`,
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error generating mind map: ${err.message}` }],
      isError: true,
    };
  }
}
