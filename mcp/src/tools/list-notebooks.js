/**
 * MCP tool: list_notebooks
 *
 * Lists NotebookLM notebooks with optional K.Y.T. project mappings.
 */

import { listNotebooks, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { getAllMappings } from '../lib/notebooklm-config.js';
import { isAuthConfigured, getAuthAgeSeconds } from '../lib/notebooklm-auth.js';

export async function listNotebooksHandler({ showMappings = true, passphrase }) {
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

  try {
    const notebooks = await listNotebooks();
    const mappings = showMappings ? getAllMappings() : [];
    const mappingsByNbId = new Map(mappings.map(m => [m.notebookId, m]));

    if (notebooks.length === 0) {
      return {
        content: [{ type: 'text', text: 'No notebooks found in your NotebookLM account.' }],
      };
    }

    const lines = [`Found ${notebooks.length} notebook(s):\n`];

    for (const nb of notebooks) {
      const mapping = mappingsByNbId.get(nb.id);
      lines.push(`- **${nb.title}** (${nb.sourceCount} sources)`);
      lines.push(`  ID: ${nb.id}`);
      if (showMappings && mapping) {
        lines.push(`  K.Y.T. project: ${mapping.projectId}`);
        if (mapping.lastPushAt) {
          lines.push(`  Last push: ${mapping.lastPushAt} (${mapping.lastTurnCount || 0} turns)`);
        }
        lines.push(`  Sources tracked: ${(mapping.sourceIds || []).length}`);
      } else if (showMappings) {
        lines.push('  K.Y.T. project: (not linked)');
      }
      lines.push('');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    const age = getAuthAgeSeconds();
    const ageHint = age !== null
      ? ` (cookies are ${Math.round(age / 60)}min old)`
      : ' (no auth file found)';
    return {
      content: [{
        type: 'text',
        text: `Error listing notebooks: ${err.message}${ageHint}\n\nTo fix: re-export cookies from your browser, or run the Playwright login flow.`,
      }],
      isError: true,
    };
  }
}
