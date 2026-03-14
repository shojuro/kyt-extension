import { getUserId, getSupabaseClient } from '../lib/supabase-client.js';

export const CREATE_PROJECT_SCHEMA = {
  name: { type: 'string', description: 'Project name' },
  description: { type: 'string', description: 'Optional project description' },
  isVault: { type: 'boolean', description: 'Whether this project is a vault (default: false)' },
};

export async function createProject({ name, description, isVault = false }) {
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return {
      content: [{ type: 'text', text: 'Error: name is required and must be a non-empty string.' }],
      isError: true,
    };
  }

  const userId = getUserId();
  const supabase = getSupabaseClient();

  const { data, error } = await supabase
    .rpc('create_project_rpc', {
      p_user_id: userId,
      p_name: name.trim(),
      p_description: description || null,
      p_is_vault: isVault,
    });

  if (error) {
    return {
      content: [{ type: 'text', text: `Failed to create project: ${error.message}` }],
      isError: true,
    };
  }

  const project = Array.isArray(data) ? data[0] : data;
  return {
    content: [{ type: 'text', text: `Project created: "${project.name}" (ID: ${project.id})${project.is_vault ? ' [VAULT]' : ''}` }],
  };
}
