/**
 * MCP tool: get_artifact_content
 *
 * Get the content of a NotebookLM artifact (quiz data, interactive HTML, etc.).
 */

import { getArtifactContent, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { sanitize } from '../lib/notebooklm-sanitizer.js';

export async function getArtifactContentHandler({ notebookId, artifactId, passphrase }) {
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
    const { html, data } = await getArtifactContent(notebookId, artifactId);

    if (!html && !data) {
      return {
        content: [{ type: 'text', text: 'Artifact returned no content. It may still be processing.' }],
      };
    }

    const lines = [];

    // If structured data (quiz/flashcards), format it nicely
    if (data) {
      lines.push('**Artifact Content (structured data):**\n');
      lines.push(sanitize(JSON.stringify(data, null, 2)));
    } else if (html) {
      // Return truncated HTML
      const sanitizedHtml = sanitize(html);
      lines.push('**Artifact Content (HTML):**\n');
      lines.push(sanitizedHtml.length > 5000
        ? sanitizedHtml.slice(0, 5000) + `\n\n... (truncated, ${sanitizedHtml.length} chars total)`
        : sanitizedHtml
      );
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error getting artifact content: ${err.message}` }],
      isError: true,
    };
  }
}
