/**
 * MCP tool: delete_notebook_note
 *
 * Delete a note from a NotebookLM notebook (soft delete).
 */

import { deleteNote, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function deleteNotebookNoteHandler({ notebookId, noteId, passphrase }) {
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

  if (!notebookId || !noteId) {
    return {
      content: [{ type: 'text', text: 'Error: both notebookId and noteId are required.' }],
      isError: true,
    };
  }

  try {
    await deleteNote(notebookId, noteId);
    return {
      content: [{ type: 'text', text: `Note ${noteId} deleted successfully.` }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error deleting note: ${err.message}` }],
      isError: true,
    };
  }
}
