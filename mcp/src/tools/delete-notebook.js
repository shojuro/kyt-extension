/**
 * MCP tool: delete_notebook
 *
 * Delete a NotebookLM notebook and clean up K.Y.T. mapping.
 */

import { deleteNotebook, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { removeNotebookMapping } from '../lib/notebooklm-config.js';

export async function deleteNotebookHandler({ notebookId, passphrase }) {
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
    return {
      content: [{ type: 'text', text: 'Error: notebookId is required.' }],
      isError: true,
    };
  }

  try {
    await deleteNotebook(notebookId);
    removeNotebookMapping(notebookId);

    return {
      content: [{ type: 'text', text: `Notebook ${notebookId} deleted and K.Y.T. mapping removed.` }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error deleting notebook: ${err.message}` }],
      isError: true,
    };
  }
}
