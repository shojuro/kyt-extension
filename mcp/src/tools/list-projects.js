import { getUserId, getSupabaseClient } from '../lib/supabase-client.js';

export const LIST_PROJECTS_SCHEMA = {
  includeArchived: { type: 'boolean', description: 'Include archived projects (default: false)' },
};

export async function listProjects({ includeArchived = false }) {
  const userId = getUserId();
  const supabase = getSupabaseClient();

  const { data: projects, error } = await supabase
    .rpc('list_projects_rpc', {
      p_user_id: userId,
      p_include_archived: includeArchived,
    });

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

  const formatted = projects.map((p, i) => {
    const vault = p.is_vault ? ' [VAULT]' : '';
    const archived = p.is_archived ? ' [ARCHIVED]' : '';
    const created = p.created_at ? new Date(p.created_at).toLocaleDateString() : '';
    return `${i + 1}. ${p.name}${vault}${archived} — ${p.item_count} items — created ${created}\n   ID: ${p.id}${p.description ? `\n   ${p.description}` : ''}`;
  }).join('\n\n');

  return {
    content: [{ type: 'text', text: `${projects.length} project(s):\n\n${formatted}` }],
  };
}
