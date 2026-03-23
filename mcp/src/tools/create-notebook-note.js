/**
 * MCP tool: create_notebook_note
 *
 * Create a note in a NotebookLM notebook.
 * Named create_notebook_note to disambiguate from K.Y.T.'s save_note.
 */

import { createNote, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function createNotebookNoteHandler({ notebookId, title, content, passphrase }) {
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

  if (!notebookId || !title || !content) {
    return {
      content: [{ type: 'text', text: 'Error: notebookId, title, and content are required.' }],
      isError: true,
    };
  }

  try {
    const { noteId } = await createNote(notebookId, title, content);

    return {
      content: [{
        type: 'text',
        text: `Note created successfully.\nTitle: ${title}\nNote ID: ${noteId}`,
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error creating note: ${err.message}` }],
      isError: true,
    };
  }
}
