import { getUserId, getSupabaseClient } from '../lib/supabase-client.js';

export const LIST_PROJECTS_SCHEMA = {
  includeArchived: { type: 'boolean', description: 'Include archived projects (default: false)' },
};

export async function listProjects({ includeArchived = false }) {
  const userId = getUserId();
  const supabase = getSupabaseClient();

  let query = supabase
    .from('projects')
    .select('*')
    .eq('user_id', userId)
    .order('name');

  if (!includeArchived) {
    query = query.eq('is_archived', false);
  }

  const { data: projects, error } = await query;

  if (error) {
    return {
      content: [{ type: 'text', text: `Failed to list projects: ${error.message}` }],
      isError: true,
    };
  }

  if (!projects || projects.length === 0) {
    return {
      content: [{ type: 'text', text: 'No projects found. Use create_project to create one.' }],
    };
  }

  // Fetch item counts per project
  const projectIds = projects.map(p => p.id);
  const { data: counts, error: countError } = await supabase
    .from('chat_turns')
    .select('project_id')
    .in('project_id', projectIds);

  const countMap = {};
  if (!countError && counts) {
    for (const row of counts) {
      if (row.project_id) {
        countMap[row.project_id] = (countMap[row.project_id] || 0) + 1;
      }
    }
  }

  const formatted = projects.map((p, i) => {
    const itemCount = countMap[p.id] || 0;
    const vault = p.is_vault ? ' [VAULT]' : '';
    const archived = p.is_archived ? ' [ARCHIVED]' : '';
    const created = p.created_at ? new Date(p.created_at).toLocaleDateString() : '';
    return `${i + 1}. ${p.name}${vault}${archived} — ${itemCount} items — created ${created}\n   ID: ${p.id}${p.description ? `\n   ${p.description}` : ''}`;
  }).join('\n\n');

  return {
    content: [{ type: 'text', text: `${projects.length} project(s):\n\n${formatted}` }],
  };
}
