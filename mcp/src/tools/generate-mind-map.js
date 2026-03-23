/**
 * MCP tool: generate_mind_map
 *
 * Generate a mind map from selected sources in a NotebookLM notebook.
 */

import { generateMindMap, listSources, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';

export async function generateMindMapHandler({ notebookId, sourceIds, passphrase }) {
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
    // If no sourceIds, use all sources
    let resolvedSourceIds = sourceIds;
    if (!resolvedSourceIds || resolvedSourceIds.length === 0) {
      const sources = await listSources(notebookId);
      resolvedSourceIds = sources.map(s => s.id);
      if (resolvedSourceIds.length === 0) {
        return {
          content: [{ type: 'text', text: 'Error: Notebook has no sources. Add sources before generating a mind map.' }],
          isError: true,
        };
      }
    }

    const { mindMap, noteId } = await generateMindMap(notebookId, resolvedSourceIds);

    if (!mindMap) {
      return {
        content: [{ type: 'text', text: 'Mind map generation returned no content. The notebook may need more sources.' }],
      };
    }

    const lines = [
      `Mind map generated and saved as note.`,
      `Note ID: ${noteId || '(unknown)'}`,
      `Sources: ${resolvedSourceIds.length}`,
      '',
    ];

    // Show mind map structure
    if (typeof mindMap === 'object' && mindMap.name) {
      lines.push(`**${mindMap.name}**`);
      if (Array.isArray(mindMap.children)) {
        for (const child of mindMap.children) {
          const name = typeof child === 'object' ? child.name || JSON.stringify(child).substring(0, 80) : String(child);
          lines.push(`  - ${name}`);
          if (child.children && Array.isArray(child.children)) {
            for (const gc of child.children.slice(0, 3)) {
              const gcName = typeof gc === 'object' ? gc.name || '...' : String(gc);
              lines.push(`    - ${gcName}`);
            }
            if (child.children.length > 3) lines.push(`    - ... (${child.children.length - 3} more)`);
          }
        }
      }
    } else {
      lines.push(JSON.stringify(mindMap).substring(0, 500));
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error generating mind map: ${err.message}` }],
      isError: true,
    };
  }
}
