/**
 * MCP tool: get_source
 *
 * Get the full text content of a NotebookLM source.
 */

import { getSourceContent, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function getSourceHandler({ notebookId, sourceId, passphrase }) {
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

  if (!notebookId || !sourceId) {
    return {
      content: [{ type: 'text', text: 'Error: both notebookId and sourceId are required.' }],
      isError: true,
    };
  }

  try {
    const { title, content } = await getSourceContent(notebookId, sourceId);

    if (!content) {
      return {
        content: [{ type: 'text', text: 'Source exists but returned no text content.' }],
      };
    }

    const lines = [];
    if (title) lines.push(`**Source: ${title}**\n`);
    lines.push(content.length > 10000
      ? content.slice(0, 10000) + `\n\n... (truncated, ${content.length} chars total)`
      : content
    );

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error getting source: ${err.message}` }],
      isError: true,
    };
  }
}
