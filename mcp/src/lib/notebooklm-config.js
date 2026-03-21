/**
 * NotebookLM ↔ K.Y.T. project mapping config.
 *
 * Persisted at ~/.kyt/notebooklm.json. Tracks:
 * - notebook ↔ project mappings
 * - last push timestamps
 * - source IDs for incremental push
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const KYT_DIR = join(homedir(), '.kyt');
const CONFIG_PATH = join(KYT_DIR, 'notebooklm.json');

function ensureDir() {
  if (!existsSync(KYT_DIR)) {
    mkdirSync(KYT_DIR, { recursive: true });
  }
}

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return { notebooks: {} };
  }
}

function writeConfig(config) {
  ensureDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

/**
 * Get the mapping for a notebook.
 *
 * @param {string} notebookId
 * @returns {{ notebookId: string, title: string, projectId: string|null, lastPushAt: string|null, lastTurnCount: number, sourceIds: string[], pushedConversationIds: string[] } | null}
 */
export function getNotebookMapping(notebookId) {
  const config = readConfig();
  return config.notebooks[notebookId] || null;
}

/**
 * Get the notebook ID mapped to a K.Y.T. project.
 *
 * @param {string} projectId
 * @returns {string|null} notebookId or null
 */
export function getNotebookForProject(projectId) {
  const config = readConfig();
  for (const [nbId, mapping] of Object.entries(config.notebooks)) {
    if (mapping.projectId === projectId) return nbId;
  }
  return null;
}

/**
 * Save or update a notebook mapping.
 *
 * @param {string} notebookId
 * @param {object} data - Partial mapping data to merge
 */
export function saveNotebookMapping(notebookId, data) {
  const config = readConfig();
  const existing = config.notebooks[notebookId] || {
    notebookId,
    title: null,
    projectId: null,
    lastPushAt: null,
    lastTurnCount: 0,
    sourceIds: [],
    pushedConversationIds: [],
  };
  config.notebooks[notebookId] = { ...existing, ...data, notebookId };
  writeConfig(config);
}

/**
 * Get all notebook mappings.
 *
 * @returns {object[]} Array of mapping objects
 */
export function getAllMappings() {
  const config = readConfig();
  return Object.values(config.notebooks);
}

/**
 * Remove a notebook mapping.
 *
 * @param {string} notebookId
 */
export function removeNotebookMapping(notebookId) {
  const config = readConfig();
  delete config.notebooks[notebookId];
  writeConfig(config);
}

/**
 * Get the lessons notebook ID (global, cross-project).
 *
 * @returns {string|null}
 */
export function getLessonsNotebookId() {
  const config = readConfig();
  return config.lessonsNotebookId || null;
}

/**
 * Set the lessons notebook ID.
 *
 * @param {string} notebookId
 */
export function setLessonsNotebookId(notebookId) {
  const config = readConfig();
  config.lessonsNotebookId = notebookId;
  writeConfig(config);
}

// ── YouTube Channel Bookmarks ──────────────────────────────────────────

/**
 * Get all saved YouTube channels.
 *
 * @returns {{ channelId: string, channelName: string, savedAt: string }[]}
 */
export function getYoutubeChannels() {
  const config = readConfig();
  return config.youtubeChannels || [];
}

/**
 * Save or update a YouTube channel bookmark.
 *
 * @param {string} channelId - YouTube channel ID (UC...)
 * @param {string} channelName - Display name
 */
export function saveYoutubeChannel(channelId, channelName) {
  const config = readConfig();
  if (!config.youtubeChannels) config.youtubeChannels = [];
  const idx = config.youtubeChannels.findIndex(c => c.channelId === channelId);
  const entry = { channelId, channelName, savedAt: new Date().toISOString() };
  if (idx >= 0) config.youtubeChannels[idx] = entry;
  else config.youtubeChannels.push(entry);
  writeConfig(config);
}

/**
 * Delete a YouTube channel bookmark.
 *
 * @param {string} channelId
 * @returns {boolean} true if found and deleted
 */
export function deleteYoutubeChannel(channelId) {
  const config = readConfig();
  const before = (config.youtubeChannels || []).length;
  config.youtubeChannels = (config.youtubeChannels || []).filter(c => c.channelId !== channelId);
  writeConfig(config);
  return config.youtubeChannels.length < before;
}
