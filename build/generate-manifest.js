#!/usr/bin/env node

/**
 * KYT Memory Extension - Manifest Generator
 *
 * Generates manifest.json by merging platform configurations.
 * Each platform provides:
 * - host_permissions (URLs to match)
 * - content_scripts matches
 * - web_accessible_resources
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ChatGPTPlatform } from '../platforms/chatgpt/ChatGPTPlatform.js';
import { ClaudePlatform } from '../platforms/claude/ClaudePlatform.js';
import { GeminiPlatform } from '../platforms/gemini/GeminiPlatform.js';
import { registry } from '../platforms/base/PlatformRegistry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

console.log('🔧 KYT Manifest Generator: Starting...');

// Register all platforms
registry.register(new ChatGPTPlatform());
registry.register(new ClaudePlatform());
registry.register(new GeminiPlatform());

console.log('✅ Registered platforms:', registry.getPlatformNames().join(', '));

// Base manifest (platform-independent)
const baseManifest = {
  manifest_version: 3,
  name: "KYT Memory - Multi-Platform",
  version: "1.0.0",
  description: "Capture and search conversations across ChatGPT, Claude, and more with long-term semantic memory",

  permissions: [
    "storage",
    "alarms"
  ],

  background: {
    service_worker: "background.js",
    type: "module"
  },

  icons: {
    "16": "icon.svg",
    "48": "icon.svg",
    "128": "icon.svg"
  },

  minimum_chrome_version: "88"
};

// Collect platform-specific configurations
const allHostPermissions = new Set();
const contentScripts = [];
const webAccessibleResources = [];

for (const platform of registry.getAllPlatforms()) {
  const name = platform.getName();
  const patterns = platform.getUrlPatterns();
  const overrides = platform.getManifestOverrides();

  console.log(`\n📦 Processing platform: ${name}`);
  console.log(`   URL patterns: ${patterns.join(', ')}`);

  // Collect host_permissions
  if (overrides.host_permissions) {
    overrides.host_permissions.forEach(perm => {
      allHostPermissions.add(perm);
      console.log(`   + Host permission: ${perm}`);
    });
  }

  // Build content_scripts entry for this platform
  const matches = patterns.map(pattern => `https://${pattern}/*`);
  contentScripts.push({
    matches: matches,
    js: [`platforms/${name}/content.js`],
    run_at: "document_start",
    all_frames: false
  });
  console.log(`   + Content script: platforms/${name}/content.js`);

  // Build web_accessible_resources entry for this platform
  webAccessibleResources.push({
    resources: [`platforms/${name}/inject.js`],
    matches: matches
  });
  console.log(`   + Web resource: platforms/${name}/inject.js`);
}

// Merge into final manifest
const finalManifest = {
  ...baseManifest,
  host_permissions: Array.from(allHostPermissions).sort(),
  content_scripts: contentScripts,
  web_accessible_resources: webAccessibleResources
};

// Write manifest.json
const manifestPath = join(projectRoot, 'manifest.json');
writeFileSync(manifestPath, JSON.stringify(finalManifest, null, 2) + '\n');

console.log('\n✅ Generated manifest.json:');
console.log(`   - ${finalManifest.host_permissions.length} host permissions`);
console.log(`   - ${finalManifest.content_scripts.length} content scripts`);
console.log(`   - ${finalManifest.web_accessible_resources.length} web resource entries`);
console.log(`   - Platforms: ${registry.getPlatformNames().join(', ')}`);
console.log('\n📄 Manifest written to:', manifestPath);

// Display registry stats
const stats = registry.getStats();
console.log('\n📊 Registry Stats:');
console.log(`   - Total platforms: ${stats.totalPlatforms}`);
console.log(`   - Context injection support: ${stats.supportsContextInjection}/${stats.totalPlatforms}`);
console.log(`   - URL patterns: ${stats.urlPatterns.join(', ')}`);

console.log('\n🎉 Manifest generation complete!');
