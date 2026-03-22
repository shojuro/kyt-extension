/**
 * MCP tool: create_notebook
 *
 * Creates a NotebookLM notebook and links it to a K.Y.T. project.
 */

import { createNotebook, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { saveNotebookMapping, getNotebookForProject } from '../lib/notebooklm-config.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { getActiveProjectId } from '../lib/config.js';

export async function createNotebookHandler({ title, projectId, passphrase }) {
  if (!isAuthConfigured()) {
    return {
      content: [{
        type: 'text',
        text: 'NotebookLM auth not configured. Use the login flow or import cookies first.',
      }],
      isError: true,
    };
  }

  if (passphrase) setPassphrase(passphrase);
  if (!hasPassphrase()) {
    return {
      content: [{
        type: 'text',
        text: 'Auth unavailable. Import cookies first (auto-key handles encryption), or pass `passphrase` to override.',
      }],
      isError: true,
    };
  }

  if (!title || typeof title !== 'string' || title.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: title is required.' }],
      isError: true,
    };
  }

  // Resolve project
  const resolvedProjectId = projectId || getActiveProjectId();

  // Check if project already has a notebook
  if (resolvedProjectId) {
    const existingNb = getNotebookForProject(resolvedProjectId);
    if (existingNb) {
      return {
        content: [{
          type: 'text',
          text: `Project ${resolvedProjectId} is already linked to notebook ${existingNb}. Use push_project_to_notebook to add sources.`,
        }],
        isError: true,
      };
    }
  }

  try {
    const { id, title: createdTitle } = await createNotebook(title.trim());

    // Save mapping
    saveNotebookMapping(id, {
      title: createdTitle,
      projectId: resolvedProjectId,
    });

    const lines = [
      `Notebook created: **${createdTitle}**`,
      `ID: ${id}`,
    ];
    if (resolvedProjectId) {
      lines.push(`Linked to K.Y.T. project: ${resolvedProjectId}`);
    } else {
      lines.push('Not linked to any K.Y.T. project (no active project set).');
    }
    lines.push('', 'Use `push_project_to_notebook` to export conversations as sources.');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error creating notebook: ${err.message}` }],
      isError: true,
    };
  }
}
