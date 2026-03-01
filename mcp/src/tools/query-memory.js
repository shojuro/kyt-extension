import { callEdgeFunction, getUserId } from '../lib/supabase-client.js';
import { getMemoryMode } from '../lib/config.js';

export const QUERY_MEMORY_SCHEMA = {
  query: { type: 'string', description: 'Search query for cross-platform memory' },
  topK: { type: 'number', description: 'Number of results to return (default: 5)' },
  useHyde: { type: 'boolean', description: 'Enable HyDE augmented search (default: true)' },
  platform: {
    type: 'string',
    description: 'Filter by platform: all, chatgpt, claude, claude-code, cli, gemini (default: all)',
  },
};

export async function queryMemory({ query, topK = 5, useHyde = true, platform = 'all', fast = false }) {
  const mode = getMemoryMode();
  if (mode === 'incognito' || mode === 'clean_room') {
    return {
      content: [{ type: 'text', text: `Memory mode is "${mode}" — query blocked. Use set_memory_mode to switch to "full".` }],
    };
  }

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: query is required and must be a non-empty string.' }],
      isError: true,
    };
  }

  const userId = getUserId();

  const body = {
    query: query.trim(),
    userId,
    useHyde: fast ? false : useHyde,
    topK,
    fast,
  };

  const result = await callEdgeFunction('search_memories', body);

  if (result.error) {
    return {
      content: [{ type: 'text', text: `Search error: ${result.error}` }],
      isError: true,
    };
  }

  const results = result.results || [];

  if (results.length === 0) {
    return {
      content: [{ type: 'text', text: `No memories found for: "${query}"` }],
    };
  }

  // Infer platform from conversation_id prefix (search results don't include platform field)
  // Filter by platform if specified
  const filtered = platform === 'all'
    ? results
    : results.filter(r => {
        const inferredPlatform = r.conversation_id?.startsWith('cc-') ? 'claude-code' : (r.platform || 'unknown');
        return inferredPlatform === platform;
      });

  const formatted = filtered.map((r, i) => {
    const score = r.rerank_score
      ? `(${(r.rerank_score * 100).toFixed(1)}%)`
      : r.vector_similarity
        ? `(${(r.vector_similarity * 100).toFixed(1)}%)`
        : '';
    const plat = r.conversation_id?.startsWith('cc-') ? '[claude-code]' : (r.platform ? `[${r.platform}]` : '');
    const date = r.created_at ? new Date(r.created_at).toLocaleDateString() : '';
    const entities = r.entities?.length ? `\n   Entities: ${r.entities.join(', ')}` : '';
    return `${i + 1}. ${plat} ${score} ${date}\n   ${r.content?.substring(0, 300)}${r.content?.length > 300 ? '...' : ''}${entities}`;
  }).join('\n\n');

  return {
    content: [{
      type: 'text',
      text: `Found ${filtered.length} memories for "${query}":\n\n${formatted}`,
    }],
  };
}
