/**
 * MCP tool: poll_research
 *
 * Poll the status of a research task in a NotebookLM notebook.
 */

import { pollResearch, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { sanitize } from '../lib/notebooklm-sanitizer.js';

export async function pollResearchHandler({ notebookId, passphrase }) {
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
    return { content: [{ type: 'text', text: 'Error: notebookId is required.' }], isError: true };
  }

  try {
    const result = await pollResearch(notebookId);

    const lines = [
      `Research status: **${result.statusLabel}**`,
      `Status code: ${result.status}`,
    ];

    if (result.taskId) lines.push(`Task ID: ${result.taskId}`);

    if (result.summary) {
      lines.push('', '**Summary:**', sanitize(result.summary));
    }

    if (result.done) {
      lines.push('', 'Research complete. Use `import_research` to add results as notebook sources.');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error polling research: ${err.message}` }],
      isError: true,
    };
  }
}
