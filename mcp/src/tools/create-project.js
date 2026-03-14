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
    .from('projects')
    .insert({
      user_id: userId,
      name: name.trim(),
      description: description || null,
      is_vault: isVault,
    })
    .select()
    .single();

  if (error) {
    return {
      content: [{ type: 'text', text: `Failed to create project: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: `Project created: "${data.name}" (ID: ${data.id})${data.is_vault ? ' [VAULT]' : ''}` }],
  };
}
