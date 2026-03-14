import { getUserId, getSupabaseClient } from '../lib/supabase-client.js';

export const SET_VAULT_PIN_SCHEMA = {
  projectId: { type: 'string', description: 'Vault project UUID' },
  pin: { type: 'string', description: 'New PIN (min 4 characters)' },
  oldPin: { type: 'string', description: 'Current PIN (required if changing an existing PIN)' },
};

export async function setVaultPin({ projectId, pin, oldPin }) {
  if (!projectId) {
    return {
      content: [{ type: 'text', text: 'Error: projectId is required.' }],
      isError: true,
    };
  }

  if (!pin || pin.trim().length < 4) {
    return {
      content: [{ type: 'text', text: 'Error: PIN must be at least 4 characters.' }],
      isError: true,
    };
  }

  const userId = getUserId();
  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc('set_vault_pin', {
    p_project_id: projectId,
    p_user_id: userId,
    p_pin: pin,
    p_old_pin: oldPin || null,
  });

  if (error) {
    return {
      content: [{ type: 'text', text: `Failed to set PIN: ${error.message}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: 'text', text: `Vault PIN set successfully for project ${projectId}.` }],
  };
}
