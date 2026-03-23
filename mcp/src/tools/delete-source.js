/**
 * MCP tool: delete_source
 *
 * Delete a source from a NotebookLM notebook.
 */

import { deleteSource, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function deleteSourceHandler({ notebookId, sourceId, passphrase }) {
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

  if (!notebookId || !sourceId) {
    return {
      content: [{ type: 'text', text: 'Error: both notebookId and sourceId are required.' }],
      isError: true,
    };
  }

  try {
    await deleteSource(notebookId, sourceId);
    return {
      content: [{ type: 'text', text: `Source ${sourceId} deleted successfully.` }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error deleting source: ${err.message}` }],
      isError: true,
    };
  }
}
