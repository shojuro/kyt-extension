import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { getUserId, getSupabaseClient } from '../lib/supabase-client.js';

export const SET_ACTIVE_PROJECT_SCHEMA = {
  projectId: { type: 'string', description: 'Project UUID to set as active (null to clear)' },
  projectName: { type: 'string', description: 'Project name (for display)' },
  pin: { type: 'string', description: 'Required PIN to unlock vault projects' },
};

export async function setActiveProject({ projectId, projectName, pin }) {
  // Clearing active project — no PIN needed
  if (!projectId) {
    return writeConfig(null, null);
  }

  const userId = getUserId();
  const supabase = getSupabaseClient();

  // Look up project to check if it's a vault
  const { data: project, error: lookupError } = await supabase
    .from('projects')
    .select('id, name, is_vault')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single();

  if (lookupError || !project) {
    return {
      content: [{ type: 'text', text: `Project not found: ${lookupError?.message || 'unknown'}` }],
      isError: true,
    };
  }

  // Vault PIN gate
  if (project.is_vault) {
    if (!pin) {
      return {
        content: [{ type: 'text', text: 'This is a vault project. Provide the PIN to unlock it.' }],
        isError: true,
      };
    }

    const { data: verified, error: verifyError } = await supabase
      .rpc('verify_vault_pin', {
        p_project_id: projectId,
        p_user_id: userId,
        p_pin: pin,
      });

    if (verifyError) {
      return {
        content: [{ type: 'text', text: `PIN verification failed: ${verifyError.message}` }],
        isError: true,
      };
    }

    if (!verified) {
      return {
        content: [{ type: 'text', text: 'Incorrect vault PIN.' }],
        isError: true,
      };
    }
  }

  return writeConfig(projectId, projectName || project.name);
}

function writeConfig(projectId, projectName) {
  const kytDir = join(homedir(), '.kyt');
  const configPath = join(kytDir, 'config.json');

  if (!existsSync(kytDir)) mkdirSync(kytDir, { recursive: true });

  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch { /* fresh config */ }

  if (projectId) {
    config.activeProjectId = projectId;
    config.activeProjectName = projectName || projectId;
  } else {
    delete config.activeProjectId;
    delete config.activeProjectName;
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  const status = projectId
    ? `Active project set to "${config.activeProjectName}" (${projectId})`
    : 'Cleared active project (general mode)';

  return {
    content: [{ type: 'text', text: status }],
  };
}
