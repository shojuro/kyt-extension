import { getSupabaseClient, getUserId } from '../lib/supabase-client.js';

export const SEARCH_ENTITIES_SCHEMA = {
  query: { type: 'string', description: 'Entity name or text to search for' },
  limit: { type: 'number', description: 'Max results to return (default: 5)' },
};

export async function searchEntities({ query, limit = 5 }) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: query is required.' }],
      isError: true,
    };
  }

  const supabase = getSupabaseClient();
  const userId = getUserId();

  // Use the search_entities_by_text RPC
  const { data, error } = await supabase.rpc('search_entities_by_text', {
    p_query_text: query.trim(),
    p_user_id: userId,
    p_match_count: limit,
  });

  if (error) {
    // Fallback: direct table query with ILIKE (column is entity_text, not entity_name)
    const { data: fallbackData, error: fallbackError } = await supabase
      .from('entities')
      .select('entity_text, entity_type, mention_count, first_seen, last_seen')
      .eq('user_id', userId)
      .ilike('entity_text', `%${query.trim()}%`)
      .order('mention_count', { ascending: false })
      .limit(limit);

    if (fallbackError) {
      return {
        content: [{ type: 'text', text: `Entity search error: ${fallbackError.message}` }],
        isError: true,
      };
    }

    return formatEntityResults(fallbackData || [], query);
  }

  return formatEntityResults(data || [], query);
}

function formatEntityResults(entities, query) {
  if (entities.length === 0) {
    return {
      content: [{ type: 'text', text: `No entities found matching "${query}".` }],
    };
  }

  const formatted = entities.map((e, i) => {
    const name = e.entity_text || e.entity_name || 'unknown';
    const mentions = e.mention_count ? `(${e.mention_count} mentions)` : '';
    const type = e.entity_type ? `[${e.entity_type}]` : '';
    const lastSeen = e.last_seen ? `Last seen: ${new Date(e.last_seen).toLocaleDateString()}` : '';
    return `${i + 1}. ${name} ${type} ${mentions}\n   ${lastSeen}`;
  }).join('\n\n');

  return {
    content: [{
      type: 'text',
      text: `Found ${entities.length} entities matching "${query}":\n\n${formatted}`,
    }],
  };
}
