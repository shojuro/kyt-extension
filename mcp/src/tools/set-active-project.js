import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const SET_ACTIVE_PROJECT_SCHEMA = {
  projectId: { type: 'string', description: 'Project UUID to set as active (null to clear)' },
  projectName: { type: 'string', description: 'Project name (for display)' },
};

export async function setActiveProject({ projectId, projectName }) {
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
