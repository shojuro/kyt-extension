import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const KYT_DIR = join(homedir(), '.kyt');
const CONFIG_PATH = join(KYT_DIR, 'config.json');
const INGESTED_PATH = join(KYT_DIR, 'ingested-sessions.json');

function ensureKytDir() {
  if (!existsSync(KYT_DIR)) {
    mkdirSync(KYT_DIR, { recursive: true });
  }
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return fallback;
  }
}

function writeJson(path, data) {
  ensureKytDir();
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

export function getMemoryMode() {
  const config = readJson(CONFIG_PATH, {});
  return config.memoryMode || 'full';
}

export function setMemoryMode(mode) {
  const config = readJson(CONFIG_PATH, {});
  config.memoryMode = mode;
  writeJson(CONFIG_PATH, config);
  return mode;
}

export function getActiveProjectId() {
  const config = readJson(CONFIG_PATH, {});
  return config.activeProjectId || null;
}

export function getIngestedSessions() {
  return readJson(INGESTED_PATH, {});
}

export function markSessionIngested(sessionId, messageCount) {
  const ingested = getIngestedSessions();
  ingested[sessionId] = { lastIngestedCount: messageCount, ingestedAt: new Date().toISOString() };
  writeJson(INGESTED_PATH, ingested);
}
