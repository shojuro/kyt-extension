/**
 * MCP tool: list_artifacts
 *
 * List artifacts in a NotebookLM notebook.
 */

import { listArtifacts, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function listArtifactsHandler({ notebookId, passphrase }) {
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
    const artifacts = await listArtifacts(notebookId);

    if (artifacts.length === 0) {
      return {
        content: [{ type: 'text', text: 'No artifacts found in this notebook.' }],
      };
    }

    const lines = [`Found ${artifacts.length} artifact(s):\n`];
    for (const art of artifacts) {
      lines.push(`- **${art.title}** (${art.typeLabel})`);
      lines.push(`  ID: ${art.id}`);
      lines.push(`  Status: ${art.statusLabel}`);
      lines.push('');
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error listing artifacts: ${err.message}` }],
      isError: true,
    };
  }
}
