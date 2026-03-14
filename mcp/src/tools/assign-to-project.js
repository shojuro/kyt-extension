import { callEdgeFunction, getUserId, getSupabaseClient } from '../lib/supabase-client.js';

export const ASSIGN_TO_PROJECT_SCHEMA = {
  query: { type: 'string', description: 'Search query to find memories to assign' },
  projectId: { type: 'string', description: 'Project UUID to assign items to' },
  confirm: { type: 'boolean', description: 'Confirm assignment (default: false — preview only)' },
};

export async function assignToProject({ query, projectId, confirm = false }) {
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: query is required and must be a non-empty string.' }],
      isError: true,
    };
  }

  if (!projectId || typeof projectId !== 'string') {
    return {
      content: [{ type: 'text', text: 'Error: projectId is required.' }],
      isError: true,
    };
  }

  const userId = getUserId();

  // Search for matching items
  const searchResult = await callEdgeFunction('search_memories', {
    query: query.trim(),
    userId,
    topK: 10,
    fast: true,
  });

  const results = searchResult.results || [];

  if (results.length === 0) {
    return {
      content: [{ type: 'text', text: `No memories found matching "${query}". Nothing to assign.` }],
    };
  }

  if (!confirm) {
    const preview = results.map((r, i) => {
      const snippet = (r.content || '').substring(0, 100);
      const plat = r.platform ? `[${r.platform}]` : '';
      return `${i + 1}. ${plat} ${snippet}${(r.content || '').length > 100 ? '...' : ''}`;
    }).join('\n');

    return {
      content: [{ type: 'text', text: `Found ${results.length} items matching "${query}":\n\n${preview}\n\nRun again with confirm=true to assign these to the project.` }],
    };
  }

  // Confirmed: assign turns to project
  const turnIds = results.map(r => r.id).filter(Boolean);

  if (turnIds.length === 0) {
    return {
      content: [{ type: 'text', text: 'No valid turn IDs found in search results.' }],
      isError: true,
    };
  }

  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc('assign_turns_to_project', {
    p_turn_ids: turnIds,
    p_project_id: projectId,
    p_user_id: userId,
  });

  if (error) {
    return {
      content: [{ type: 'text', text: `Failed to assign turns: ${error.message}` }],
      isError: true,
    };
  }

  const assignedCount = data || turnIds.length;
  return {
    content: [{ type: 'text', text: `Assigned ${assignedCount} item(s) to project ${projectId}.` }],
  };
}
