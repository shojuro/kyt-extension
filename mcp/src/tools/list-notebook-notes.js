/**
 * MCP tool: list_notebook_notes
 *
 * List notes and mind maps in a NotebookLM notebook.
 */

import { listNotes, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function listNotebookNotesHandler({ notebookId, passphrase }) {
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

  if (!notebookId) {
    return { content: [{ type: 'text', text: 'Error: notebookId is required.' }], isError: true };
  }

  try {
    const { notes, mindMaps } = await listNotes(notebookId);

    if (notes.length === 0 && mindMaps.length === 0) {
      return {
        content: [{ type: 'text', text: 'No notes or mind maps found in this notebook.' }],
      };
    }

    const lines = [];

    if (notes.length > 0) {
      lines.push(`**Notes** (${notes.length}):\n`);
      for (const note of notes) {
        lines.push(`- **${note.title}**`);
        lines.push(`  ID: ${note.id}`);
        if (note.content) {
          const preview = note.content.slice(0, 100).replace(/\n/g, ' ');
          lines.push(`  Preview: ${preview}${note.content.length > 100 ? '...' : ''}`);
        }
        lines.push('');
      }
    }

    if (mindMaps.length > 0) {
      lines.push(`**Mind Maps** (${mindMaps.length}):\n`);
      for (const mm of mindMaps) {
        lines.push(`- **${mm.title}**`);
        lines.push(`  ID: ${mm.id}`);
        lines.push('');
      }
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error listing notes: ${err.message}` }],
      isError: true,
    };
  }
}
