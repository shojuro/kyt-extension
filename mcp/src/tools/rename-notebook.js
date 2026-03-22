/**
 * MCP tool: rename_notebook
 *
 * Rename a NotebookLM notebook and update local K.Y.T. mapping.
 */

import { renameNotebook, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { getNotebookMapping, saveNotebookMapping } from '../lib/notebooklm-config.js';

export async function renameNotebookHandler({ notebookId, newTitle, passphrase }) {
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

  if (!notebookId || !newTitle) {
    return {
      content: [{ type: 'text', text: 'Error: both notebookId and newTitle are required.' }],
      isError: true,
    };
  }

  try {
    await renameNotebook(notebookId, newTitle);

    // Update local mapping if it exists
    const mapping = getNotebookMapping(notebookId);
    if (mapping) {
      saveNotebookMapping(notebookId, { title: newTitle });
    }

    return {
      content: [{ type: 'text', text: `Notebook renamed to "${newTitle}".` }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error renaming notebook: ${err.message}` }],
      isError: true,
    };
  }
}
