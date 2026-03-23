/**
 * MCP tool: import_research
 *
 * Import research results as sources into a NotebookLM notebook.
 */

import { importResearch, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function importResearchHandler({ notebookId, taskId, sources, passphrase }) {
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

  if (!notebookId || !taskId || !sources || sources.length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: notebookId, taskId, and sources (array of {url, title}) are required.' }],
      isError: true,
    };
  }

  try {
    await importResearch(notebookId, taskId, sources);

    return {
      content: [{
        type: 'text',
        text: `Imported ${sources.length} research source(s) into notebook.\nSources: ${sources.map(s => s.title || s.url).join(', ')}`,
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error importing research: ${err.message}` }],
      isError: true,
    };
  }
}
