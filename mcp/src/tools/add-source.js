/**
 * MCP tool: add_source
 *
 * Add a source to a NotebookLM notebook (text, URL, YouTube, or Google Drive).
 */

import { addSource, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function addSourceHandler({ notebookId, sourceType, title, content, url, fileId, mimeType, passphrase }) {
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
    return {
      content: [{ type: 'text', text: 'Error: notebookId is required.' }],
      isError: true,
    };
  }

  if (!sourceType || !['text', 'url', 'youtube', 'gdrive'].includes(sourceType)) {
    return {
      content: [{ type: 'text', text: 'Error: sourceType must be one of: text, url, youtube, gdrive.' }],
      isError: true,
    };
  }

  // Validate type-specific params
  if (sourceType === 'text' && !content) {
    return {
      content: [{ type: 'text', text: 'Error: content is required for text sources.' }],
      isError: true,
    };
  }
  if ((sourceType === 'url' || sourceType === 'youtube') && !url) {
    return {
      content: [{ type: 'text', text: `Error: url is required for ${sourceType} sources.` }],
      isError: true,
    };
  }
  if (sourceType === 'gdrive' && !fileId) {
    return {
      content: [{ type: 'text', text: 'Error: fileId is required for gdrive sources.' }],
      isError: true,
    };
  }

  try {
    const { sourceId } = await addSource(notebookId, {
      type: sourceType,
      title: title || undefined,
      content: content || undefined,
      url: url || undefined,
      fileId: fileId || undefined,
      mimeType: mimeType || undefined,
    });

    return {
      content: [{
        type: 'text',
        text: `Source added successfully.\nType: ${sourceType}\nSource ID: ${sourceId || '(pending processing)'}`,
      }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error adding source: ${err.message}` }],
      isError: true,
    };
  }
}
