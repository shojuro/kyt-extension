import { getUserId, getSupabaseClient } from '../lib/supabase-client.js';

export const PROJECT_DEBRIEF_SCHEMA = {
  projectId: { type: 'string', description: 'Project UUID to debrief' },
  limit: { type: 'number', description: 'Max items to include in summary (default: 20)' },
};

export async function projectDebrief({ projectId, limit = 20 }) {
  if (!projectId || typeof projectId !== 'string') {
    return {
      content: [{ type: 'text', text: 'Error: projectId is required.' }],
      isError: true,
    };
  }

  const userId = getUserId();
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc('get_project_summary', {
    p_project_id: projectId,
    p_user_id: userId,
    p_limit: limit,
  });

  if (error) {
    // Fallback: fetch project + recent turns directly
    const { data: project, error: projError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    if (projError) {
      return {
        content: [{ type: 'text', text: `Failed to load project: ${projError.message}` }],
        isError: true,
      };
    }

    const { data: turns, error: turnsError } = await supabase
      .from('chat_turns')
      .select('id, content, platform, created_at, speakers')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (turnsError) {
      return {
        content: [{ type: 'text', text: `Failed to load project items: ${turnsError.message}` }],
        isError: true,
      };
    }

    const itemCount = turns ? turns.length : 0;
    const vault = project.is_vault ? ' [VAULT]' : '';
    const header = `Project: ${project.name}${vault}\nDescription: ${project.description || '(none)'}\nItems: ${itemCount}\nCreated: ${project.created_at ? new Date(project.created_at).toLocaleDateString() : 'unknown'}`;

    if (!turns || turns.length === 0) {
      return {
        content: [{ type: 'text', text: `${header}\n\nNo items in this project yet. Use assign_to_project to add memories.` }],
      };
    }

    const items = turns.map((t, i) => {
      const plat = t.platform ? `[${t.platform}]` : '';
      const date = t.created_at ? new Date(t.created_at).toLocaleDateString() : '';
      const snippet = (t.content || '').substring(0, 200);
      return `${i + 1}. ${plat} ${date}\n   ${snippet}${(t.content || '').length > 200 ? '...' : ''}`;
    }).join('\n\n');

    return {
      content: [{ type: 'text', text: `${header}\n\nRecent items:\n\n${items}` }],
    };
  }

  // RPC returns TABLE (id, content, created_at, platform, speakers)
  const turns = Array.isArray(data) ? data : [];
  if (turns.length === 0) {
    return {
      content: [{ type: 'text', text: 'No items in this project yet. Use assign_to_project to add memories.' }],
    };
  }

  // Fetch project metadata for header
  const { data: project } = await supabase
    .from('projects')
    .select('name, description, is_vault, created_at')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single();

  const projName = project?.name || projectId;
  const vault = project?.is_vault ? ' [VAULT]' : '';
  const desc = project?.description || '(none)';
  const header = `Project: ${projName}${vault}\nDescription: ${desc}\nItems shown: ${turns.length}\nCreated: ${project?.created_at ? new Date(project.created_at).toLocaleDateString() : 'unknown'}`;

  const items = turns.map((r, i) => {
    const plat = r.platform ? `[${r.platform}]` : '';
    const date = r.created_at ? new Date(r.created_at).toLocaleDateString() : '';
    const snippet = (r.content || '').substring(0, 200);
    return `${i + 1}. ${plat} ${date}\n   ${snippet}${(r.content || '').length > 200 ? '...' : ''}`;
  }).join('\n\n');

  return {
    content: [{ type: 'text', text: `${header}\n\nRecent items:\n\n${items}` }],
  };
}
