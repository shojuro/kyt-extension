/**
 * MCP tool: delete_artifact
 *
 * Delete an artifact from a NotebookLM notebook.
 */

import { deleteArtifact, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function deleteArtifactHandler({ notebookId, artifactId, passphrase }) {
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

  if (!notebookId || !artifactId) {
    return {
      content: [{ type: 'text', text: 'Error: both notebookId and artifactId are required.' }],
      isError: true,
    };
  }

  try {
    await deleteArtifact(notebookId, artifactId);
    return {
      content: [{ type: 'text', text: `Artifact ${artifactId} deleted successfully.` }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error deleting artifact: ${err.message}` }],
      isError: true,
    };
  }
}
