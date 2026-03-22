/**
 * MCP tool: update_notebook_note
 *
 * Update a note's title and/or content in a NotebookLM notebook.
 */

import { updateNote, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function updateNotebookNoteHandler({ notebookId, noteId, title, content, passphrase }) {
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

  if (!notebookId || !noteId) {
    return {
      content: [{ type: 'text', text: 'Error: notebookId and noteId are required.' }],
      isError: true,
    };
  }

  if (!title && !content) {
    return {
      content: [{ type: 'text', text: 'Error: at least one of title or content must be provided.' }],
      isError: true,
    };
  }

  try {
    await updateNote(notebookId, noteId, title || '', content || '');

    return {
      content: [{ type: 'text', text: `Note ${noteId} updated successfully.` }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error updating note: ${err.message}` }],
      isError: true,
    };
  }
}
