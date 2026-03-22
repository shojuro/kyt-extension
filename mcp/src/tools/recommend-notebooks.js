/**
 * MCP tool: recommend_notebooks
 *
 * Lightweight notebook discovery — no NLM queries.
 * Returns ranked notebook suggestions with relevance reasons.
 * Fast: ~200ms cached, ~3-5s cold.
 */

import { listNotebooks, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { getAllMappings } from '../lib/notebooklm-config.js';
import { callEdgeFunction, getUserId } from '../lib/supabase-client.js';
import {
  extractKeywords,
  scoreByTitle,
  scoreByEntityGraph,
  mergeAndRank,
  getCachedNotebooks,
} from '../lib/notebook-discovery.js';

export async function recommendNotebooksHandler({ query, maxResults = 10, passphrase }) {
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

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: query is required.' }],
      isError: true,
    };
  }

  try {
    const startTime = Date.now();

    // 1. Get all notebooks (cached)
    const notebooks = await getCachedNotebooks(() => listNotebooks());
    const keywords = extractKeywords(query.trim());

    if (keywords.length === 0) {
      return {
        content: [{ type: 'text', text: 'Could not extract meaningful keywords from query. Try a more specific topic.' }],
      };
    }

    // 2. Title scoring (works for all notebooks)
    const titleScored = scoreByTitle(notebooks, keywords);

    // 3. Entity graph scoring (only for linked notebooks)
    let entityScored = [];
    try {
      const userId = getUserId();
      const entityResult = await callEdgeFunction('search_entities_by_text', {
        p_query_text: query.trim(),
        p_user_id: userId,
        p_match_count: 10,
      });

      if (entityResult?.length > 0) {
        // Build project → notebook map
        const mappings = getAllMappings();
        const projectToNotebook = new Map();
        for (const m of mappings) {
          if (m.projectId) projectToNotebook.set(m.projectId, m.notebookId);
        }

        if (projectToNotebook.size > 0) {
          // Get entity IDs for graph walk
          const entityIds = entityResult.map(e => e.id).filter(Boolean);

          if (entityIds.length > 0) {
            try {
              const graphResult = await callEdgeFunction('graph_walk_from_entities', {
                p_entity_ids: entityIds,
                p_user_id: userId,
                p_max_hops: 1,
              });

              // Graph walk returns chat_turn data — extract project_ids
              const projectIds = (graphResult || [])
                .filter(r => r.project_id)
                .map(r => ({ project_id: r.project_id }));

              entityScored = scoreByEntityGraph(entityResult, projectIds, projectToNotebook);
            } catch { /* Graph walk failed — proceed with title-only */ }
          }
        }
      }
    } catch { /* Entity search failed — proceed with title-only */ }

    // 4. Merge and rank
    const ranked = mergeAndRank(titleScored, entityScored);
    const topResults = ranked.slice(0, Math.min(maxResults, 20));
    const latencyMs = Date.now() - startTime;

    if (topResults.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No notebooks found matching "${query.trim()}" (searched ${notebooks.length} notebooks, ${latencyMs}ms).`,
        }],
      };
    }

    // 5. Enrich with project link status
    const mappings = getAllMappings();
    const linkedNotebooks = new Set(mappings.map(m => m.notebookId));

    const lines = [
      `**Recommended Notebooks** for "${query.trim()}"`,
      `${topResults.length} of ${notebooks.length} notebooks matched (${latencyMs}ms)`,
      '',
    ];

    for (const [i, r] of topResults.entries()) {
      const linked = linkedNotebooks.has(r.notebookId) ? 'linked' : 'not linked';
      const score = (r.combinedScore * 100).toFixed(0);
      lines.push(
        `${String(i + 1).padStart(2)}. **${r.title || '(untitled)'}** (${r.sourceCount} sources, ${linked})`,
        `    Relevance: ${score}% — ${r.reason}`,
        `    ID: ${r.notebookId}`,
        '',
      );
    }

    lines.push('Use `search_across_notebooks` with specific notebook IDs to query them.');

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error recommending notebooks: ${err.message}` }],
      isError: true,
    };
  }
}
