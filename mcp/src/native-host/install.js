#!/usr/bin/env node
/**
 * Install the K.Y.T. native messaging host for Chrome/Chromium.
 *
 * Usage:
 *   node install.js <extension-id>
 *   node install.js --detect
 *
 * This writes the native messaging host manifest to the correct Chrome
 * directory so the extension can communicate with kyt-cookie-host.js.
 */

import { writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { homedir, platform } from 'os';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOST_NAME = 'com.kyt.cookie_host';
const HOST_SCRIPT = resolve(join(__dirname, 'kyt-cookie-host.js'));

// --- Detect Chrome NativeMessagingHosts directory ---
function getNativeHostDirs() {
  const home = homedir();
  const os = platform();

  if (os === 'linux') {
    return [
      join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
      join(home, '.config', 'chromium', 'NativeMessagingHosts'),
      join(home, '.config', 'google-chrome-beta', 'NativeMessagingHosts'),
      join(home, '.config', 'google-chrome-unstable', 'NativeMessagingHosts'),
    ];
  } else if (os === 'darwin') {
    return [
      join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
      join(home, 'Library', 'Application Support', 'Chromium', 'NativeMessagingHosts'),
    ];
  } else if (os === 'win32') {
    // Windows uses registry — provide the user-level path
    const appData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      join(appData, 'Google', 'Chrome', 'User Data', 'NativeMessagingHosts'),
    ];
  }
  return [];
}

// --- Auto-detect extension ID from Chrome profile ---
function detectExtensionId() {
  const home = homedir();
  const os = platform();

  // Look in Chrome preferences for our extension name
  const prefsPaths = os === 'linux'
    ? [join(home, '.config', 'google-chrome', 'Default', 'Preferences')]
    : os === 'darwin'
    ? [join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Preferences')]
    : [];

  for (const prefsPath of prefsPaths) {
    try {
      const prefs = JSON.parse(require('fs').readFileSync(prefsPath, 'utf8'));
      const extensions = prefs?.extensions?.settings || {};
      for (const [id, ext] of Object.entries(extensions)) {
        if (ext?.manifest?.name?.includes('KYT') || ext?.manifest?.name?.includes('K.Y.T')) {
          return id;
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

// --- Main ---
let extensionId = process.argv[2];

if (!extensionId || extensionId === '--detect') {
  const detected = detectExtensionId();
  if (detected) {
    console.log(`Auto-detected extension ID: ${detected}`);
    extensionId = detected;
  } else {
    console.error('Could not auto-detect extension ID.');
    console.error('Usage: node install.js <extension-id>');
    console.error('');
    console.error('Find your extension ID at chrome://extensions (enable Developer mode)');
    process.exit(1);
  }
}

// Validate extension ID format
if (!/^[a-z]{32}$/.test(extensionId)) {
  console.error(`Invalid extension ID: "${extensionId}"`);
  console.error('Extension IDs are 32 lowercase letters. Find yours at chrome://extensions.');
  process.exit(1);
}

// Build manifest
const manifest = {
  name: HOST_NAME,
  description: 'K.Y.T. NotebookLM cookie bridge — exports Google auth cookies from Chrome to MCP server',
  path: HOST_SCRIPT,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
};

// Make host script executable
try {
  execSync(`chmod +x "${HOST_SCRIPT}"`);
} catch {
  console.warn('Warning: could not chmod +x the host script (may need manual fix on this OS)');
}

// Install to all detected Chrome directories
const dirs = getNativeHostDirs();
let installed = 0;

for (const dir of dirs) {
  // Only install to directories whose parent exists (Chrome is installed)
  const parentDir = dirname(dir);
  if (!existsSync(parentDir)) continue;

  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const manifestPath = join(dir, `${HOST_NAME}.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`✓ Installed: ${manifestPath}`);
  installed++;
}

if (installed === 0) {
  console.error('No Chrome/Chromium installation found. Searched:');
  for (const dir of dirs) console.error(`  ${dir}`);
  process.exit(1);
}

console.log(`\nDone. ${installed} manifest(s) installed for extension ${extensionId}.`);
console.log('Restart Chrome for the native host to be recognized.');
