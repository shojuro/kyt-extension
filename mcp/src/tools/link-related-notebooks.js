/**
 * MCP tool: link_related_notebooks
 *
 * Find notebooks related to a given notebook via title similarity
 * and shared entities (for linked notebooks).
 */

import { listNotebooks, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { getAllMappings, getNotebookMapping } from '../lib/notebooklm-config.js';
import { callEdgeFunction, getUserId } from '../lib/supabase-client.js';
import {
  extractKeywords,
  scoreByTitle,
  scoreByEntityGraph,
  mergeAndRank,
  getCachedNotebooks,
} from '../lib/notebook-discovery.js';

export async function linkRelatedNotebooksHandler({ notebookId, maxResults = 5, passphrase }) {
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
    const startTime = Date.now();

    // 1. Get target notebook info
    const notebooks = await getCachedNotebooks(() => listNotebooks());
    const target = notebooks.find(n => n.id === notebookId);

    if (!target) {
      return {
        content: [{ type: 'text', text: `Notebook ${notebookId} not found.` }],
        isError: true,
      };
    }

    // 2. Extract keywords from target notebook title
    const keywords = extractKeywords(target.title || '');

    if (keywords.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `Cannot find related notebooks — "${target.title}" has no extractable keywords. Try recommend_notebooks with a topic query instead.`,
        }],
      };
    }

    // 3. Title scoring against all OTHER notebooks
    const otherNotebooks = notebooks.filter(n => n.id !== notebookId);
    const titleScored = scoreByTitle(otherNotebooks, keywords);

    // 4. Entity graph scoring (if target has project link)
    let entityScored = [];
    const mapping = getNotebookMapping(notebookId);

    if (mapping?.projectId) {
      try {
        const userId = getUserId();
        // Search entities using the notebook title as query
        const entityResult = await callEdgeFunction('search_entities_by_text', {
          p_query_text: target.title,
          p_user_id: userId,
          p_match_count: 15,
        });

        if (entityResult?.length > 0) {
          const mappings = getAllMappings();
          const projectToNotebook = new Map();
          for (const m of mappings) {
            // Exclude the target notebook's own project
            if (m.projectId && m.notebookId !== notebookId) {
              projectToNotebook.set(m.projectId, m.notebookId);
            }
          }

          if (projectToNotebook.size > 0) {
            const entityIds = entityResult.map(e => e.id).filter(Boolean);
            if (entityIds.length > 0) {
              try {
                const graphResult = await callEdgeFunction('graph_walk_from_entities', {
                  p_entity_ids: entityIds,
                  p_user_id: userId,
                  p_max_hops: 2,
                });
                const projectIds = (graphResult || [])
                  .filter(r => r.project_id && r.project_id !== mapping.projectId)
                  .map(r => ({ project_id: r.project_id }));
                entityScored = scoreByEntityGraph(entityResult, projectIds, projectToNotebook);
              } catch { /* Graph walk failed */ }
            }
          }
        }
      } catch { /* Entity search failed */ }
    }

    // 5. Merge and rank
    const ranked = mergeAndRank(titleScored, entityScored);
    const topResults = ranked.slice(0, Math.min(maxResults, 10));
    const latencyMs = Date.now() - startTime;

    if (topResults.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No related notebooks found for "${target.title}" (searched ${otherNotebooks.length} notebooks, ${latencyMs}ms).`,
        }],
      };
    }

    // 6. Format response
    const linkedNotebooks = new Set(getAllMappings().map(m => m.notebookId));

    const lines = [
      `**Notebooks Related to**: "${target.title}"`,
      `${topResults.length} related notebooks found (${latencyMs}ms)`,
      '',
    ];

    for (const [i, r] of topResults.entries()) {
      const linked = linkedNotebooks.has(r.notebookId) ? 'linked' : 'not linked';
      const score = (r.combinedScore * 100).toFixed(0);
      lines.push(
        `${i + 1}. **${r.title || '(untitled)'}** (${r.sourceCount} sources, ${linked})`,
        `   Relationship: ${r.reason} (${score}%)`,
        `   ID: ${r.notebookId}`,
        '',
      );
    }

    lines.push('Use `search_across_notebooks` to query related notebooks together.');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error finding related notebooks: ${err.message}` }],
      isError: true,
    };
  }
}
