#!/usr/bin/env node

/**
 * KYT Memory Extension - Firefox Manifest Generator
 *
 * Reads the Chrome manifest.json and produces manifest-firefox.json
 * with Firefox-specific adaptations:
 * - Removes `minimum_chrome_version`
 * - Adds `browser_specific_settings.gecko`
 * - Removes `world: "MAIN"` from content_scripts (unsupported)
 * - Adjusts `background` section (Firefox MV3 uses "scripts" array, not "service_worker")
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

console.log('🦊 Firefox Manifest Generator: Starting...');

// Read Chrome manifest as base
const chromeManifest = JSON.parse(
  readFileSync(join(projectRoot, 'manifest.json'), 'utf-8')
);

// Deep clone
const firefoxManifest = JSON.parse(JSON.stringify(chromeManifest));

// 1. Remove Chrome-specific keys
delete firefoxManifest.minimum_chrome_version;

// 2. Add Firefox-specific settings
firefoxManifest.browser_specific_settings = {
  gecko: {
    id: 'kyt-memory@kyt.app',
    strict_min_version: '109.0',
  },
};

// 3. Convert background service_worker → background.scripts
// Firefox MV3 supports service_worker but with "scripts" array syntax
// as of Firefox 121+. For broader compat, use the scripts array.
if (firefoxManifest.background?.service_worker) {
  firefoxManifest.background = {
    scripts: [firefoxManifest.background.service_worker],
    type: firefoxManifest.background.type || 'module',
  };
}

// 4. Remove `world: "MAIN"` from content_scripts (Chrome-only)
// Firefox doesn't support content script world isolation.
// The MAIN-world script (content_test.js) injects via page script instead.
if (firefoxManifest.content_scripts) {
  for (const cs of firefoxManifest.content_scripts) {
    if (cs.world) {
      console.log(`   ⚠️  Removed world: "${cs.world}" from content_script (${cs.js?.join(', ')})`);
      delete cs.world;
    }
  }
}

// 5. Remove `identity` permission if present (Firefox has no chrome.identity)
// OAuth handled via web-based flow on Firefox
const identityIdx = firefoxManifest.permissions?.indexOf('identity');
if (identityIdx > -1) {
  firefoxManifest.permissions.splice(identityIdx, 1);
  console.log('   ⚠️  Removed "identity" permission (use web-based OAuth on Firefox)');
}

// Write Firefox manifest
const outPath = join(projectRoot, 'manifest-firefox.json');
writeFileSync(outPath, JSON.stringify(firefoxManifest, null, 2) + '\n');

console.log('\n✅ Generated manifest-firefox.json:');
console.log(`   - Gecko ID: ${firefoxManifest.browser_specific_settings.gecko.id}`);
console.log(`   - Min version: ${firefoxManifest.browser_specific_settings.gecko.strict_min_version}`);
console.log(`   - Background: scripts array (${firefoxManifest.background.scripts?.join(', ')})`);
console.log(`   - ${firefoxManifest.content_scripts?.length} content scripts`);
console.log(`   - ${firefoxManifest.permissions?.length} permissions: ${firefoxManifest.permissions?.join(', ')}`);
console.log(`\n📄 Written to: ${outPath}`);
