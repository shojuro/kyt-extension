/**
 * MCP tool: list_sources
 *
 * List sources in a NotebookLM notebook.
 */

import { listSources, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function listSourcesHandler({ notebookId, passphrase }) {
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
    return {
      content: [{ type: 'text', text: 'Error: notebookId is required.' }],
      isError: true,
    };
  }

  try {
    const sources = await listSources(notebookId);

    if (sources.length === 0) {
      return {
        content: [{ type: 'text', text: 'No sources found in this notebook.' }],
      };
    }

    const lines = [`Found ${sources.length} source(s):\n`];
    for (const src of sources) {
      lines.push(`- **${src.title}** (${src.type})`);
      lines.push(`  ID: ${src.id}`);
      if (src.url) lines.push(`  URL: ${src.url}`);
      lines.push('');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error listing sources: ${err.message}` }],
      isError: true,
    };
  }
}
