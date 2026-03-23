/**
 * MCP tool: search_across_notebooks
 *
 * Discovers relevant notebooks via title matching + entity graph,
 * then queries each with askQuestion. Returns per-notebook answers
 * with provenance and citations.
 */

import { listNotebooks, askQuestion, setPassphrase, hasPassphrase } from '../lib/notebooklm-client.js';
import { isAuthConfigured } from '../lib/notebooklm-auth.js';
import { getAllMappings, getNotebookMapping } from '../lib/notebooklm-config.js';
import { callEdgeFunction, getUserId } from '../lib/supabase-client.js';
import { sanitize, detectInjection, wrapWithProvenance } from '../lib/notebooklm-sanitizer.js';
import {
  extractKeywords,
  scoreByTitle,
  scoreByEntityGraph,
  mergeAndRank,
  getCachedNotebooks,
} from '../lib/notebook-discovery.js';

export async function searchAcrossNotebooksHandler({
  question, notebookIds, maxNotebooks = 3, saveToKyt = true, passphrase,
}) {
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

  if (!question || typeof question !== 'string' || question.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: question is required.' }],
      isError: true,
    };
  }

  const clampedMax = Math.min(Math.max(maxNotebooks, 1), 5);

  try {
    const startTime = Date.now();
    let targetNotebooks = [];

    // ── Discovery phase ──
    if (notebookIds && notebookIds.length > 0) {
      // Skip discovery — use provided IDs
      const allNotebooks = await getCachedNotebooks(() => listNotebooks());
      const nbMap = new Map(allNotebooks.map(n => [n.id, n]));
      targetNotebooks = notebookIds.slice(0, clampedMax).map(id => ({
        notebookId: id,
        title: nbMap.get(id)?.title || id,
        reason: 'user-specified',
      }));
    } else {
      // Run discovery
      const notebooks = await getCachedNotebooks(() => listNotebooks());
      const keywords = extractKeywords(question.trim());

      if (keywords.length === 0) {
        return {
          content: [{ type: 'text', text: 'Could not extract meaningful keywords. Provide specific notebookIds or a more specific question.' }],
          isError: true,
        };
      }

      // Title scoring
      const titleScored = scoreByTitle(notebooks, keywords);

      // Entity graph scoring
      let entityScored = [];
      try {
        const userId = getUserId();
        const entityResult = await callEdgeFunction('search_entities_by_text', {
          p_query_text: question.trim(),
          p_user_id: userId,
          p_match_count: 10,
        });

        if (entityResult?.length > 0) {
          const mappings = getAllMappings();
          const projectToNotebook = new Map();
          for (const m of mappings) {
            if (m.projectId) projectToNotebook.set(m.projectId, m.notebookId);
          }

          if (projectToNotebook.size > 0) {
            const entityIds = entityResult.map(e => e.id).filter(Boolean);
            if (entityIds.length > 0) {
              try {
                const graphResult = await callEdgeFunction('graph_walk_from_entities', {
                  p_entity_ids: entityIds,
                  p_user_id: userId,
                  p_max_hops: 1,
                });
                const projectIds = (graphResult || [])
                  .filter(r => r.project_id)
                  .map(r => ({ project_id: r.project_id }));
                entityScored = scoreByEntityGraph(entityResult, projectIds, projectToNotebook);
              } catch { /* Graph walk failed */ }
            }
          }
        }
      } catch { /* Entity search failed */ }

      const ranked = mergeAndRank(titleScored, entityScored);
      targetNotebooks = ranked.slice(0, clampedMax).map(r => ({
        notebookId: r.notebookId,
        title: r.title,
        reason: r.reason,
      }));
    }

    if (targetNotebooks.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No notebooks found matching your question. Try providing specific notebookIds.`,
        }],
      };
    }

    const discoveryMs = Date.now() - startTime;

    // ── Query phase ──
    const results = [];
    for (const nb of targetNotebooks) {
      const queryStart = Date.now();
      try {
        const { answer, citations } = await askQuestion(nb.notebookId, question.trim());
        results.push({
          ...nb,
          answer: answer ? sanitize(answer) : null,
          citations: citations || [],
          injection: answer ? detectInjection(answer) : { hasInjection: false, patterns: [] },
          latencyMs: Date.now() - queryStart,
          error: null,
        });
      } catch (err) {
        results.push({
          ...nb,
          answer: null,
          citations: [],
          injection: { hasInjection: false, patterns: [] },
          latencyMs: Date.now() - queryStart,
          error: err.message,
        });
      }
    }

    const totalMs = Date.now() - startTime;
    const allNotebooks = await getCachedNotebooks(() => listNotebooks());

    // ── Save to K.Y.T. ──
    if (saveToKyt) {
      for (const r of results) {
        if (!r.answer) continue;
        try {
          const userId = getUserId();
          const mapping = getNotebookMapping(r.notebookId);
          const notebookTitle = mapping?.title || r.title;
          const content = `Cross-notebook Q: ${question.trim()}\n\nFrom "${notebookTitle}":\n${r.answer}`;
          const wrapped = wrapWithProvenance(content, notebookTitle);

          await callEdgeFunction('save_chat_turn_batch', {
            userId,
            messages: [{
              content: wrapped,
              platform: 'notebooklm',
              conversationId: `nlm-cross-${r.notebookId}`,
              speakers: ['user', 'assistant'],
              contentType: 'research',
            }],
          });
        } catch { /* Save failed — non-fatal */ }
      }
    }

    // ── Format response ──
    const lines = [
      `**Cross-Notebook Search**: "${question.trim()}"`,
      `Queried ${results.length} of ${allNotebooks.length} notebooks (discovery: ${discoveryMs}ms, total: ${(totalMs / 1000).toFixed(1)}s)`,
      '',
    ];

    for (const [i, r] of results.entries()) {
      lines.push(`---`);
      lines.push(`**${i + 1}. ${r.title || '(untitled)'}** (relevance: ${r.reason})`);

      if (r.error) {
        lines.push(`Error: ${r.error}`, '');
        continue;
      }

      if (!r.answer) {
        lines.push('No answer returned (notebook may have no sources).', '');
        continue;
      }

      lines.push('', r.answer);

      if (r.citations.length > 0) {
        lines.push('', '**Citations:**');
        for (const [j, c] of r.citations.entries()) {
          lines.push(`[${j + 1}] ${(c.cited_text || '').slice(0, 200)}${c.source_id ? ` (source: ${c.source_id})` : ''}`);
        }
      }

      if (r.injection.hasInjection) {
        lines.push('', `Warning: Injection patterns detected and sanitized: ${r.injection.patterns.join(', ')}`);
      }

      lines.push('');
    }

    if (saveToKyt) {
      const saved = results.filter(r => r.answer).length;
      if (saved > 0) lines.push(`Saved ${saved} answer(s) to K.Y.T. as research notes.`);
    }

    return {
      content: [{ type: 'text', text: lines.join('\n') }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Error in cross-notebook search: ${err.message}` }],
      isError: true,
    };
  }
}
