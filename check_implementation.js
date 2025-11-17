/**
 * Implementation Verification Script
 *
 * Checks that all WebSocket + Deduplication code is properly integrated
 * Run this BEFORE manual testing to verify code completeness
 *
 * Usage: node check_implementation.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ANSI colors for output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function checkFileExists(filePath, description) {
  const fullPath = path.join(__dirname, filePath);
  const exists = fs.existsSync(fullPath);

  if (exists) {
    log(`✅ ${description}: ${filePath}`, 'green');
    return true;
  } else {
    log(`❌ ${description} NOT FOUND: ${filePath}`, 'red');
    return false;
  }
}

function checkFileContains(filePath, searchStrings, description) {
  const fullPath = path.join(__dirname, filePath);

  if (!fs.existsSync(fullPath)) {
    log(`❌ ${description}: File not found - ${filePath}`, 'red');
    return false;
  }

  const content = fs.readFileSync(fullPath, 'utf8');
  const results = [];

  for (const search of searchStrings) {
    const found = content.includes(search);
    results.push(found);

    if (!found) {
      log(`  ❌ Missing: "${search.substring(0, 50)}..."`, 'red');
    }
  }

  const allFound = results.every(r => r);

  if (allFound) {
    log(`✅ ${description}: All ${searchStrings.length} checks passed`, 'green');
  } else {
    const passed = results.filter(r => r).length;
    log(`⚠️  ${description}: ${passed}/${searchStrings.length} checks passed`, 'yellow');
  }

  return allFound;
}

function checkManifestLoadOrder() {
  const manifestPath = path.join(__dirname, 'manifest.json');
  const content = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(content);

  // Find ChatGPT content_scripts entry
  const chatgptScript = manifest.content_scripts.find(script =>
    script.matches.some(match => match.includes('chatgpt.com'))
  );

  if (!chatgptScript) {
    log(`❌ Manifest: ChatGPT content_scripts not found`, 'red');
    return false;
  }

  const jsFiles = chatgptScript.js;
  const dedupeIndex = jsFiles.indexOf('platforms/chatgpt/deduplication.js');
  const contentIndex = jsFiles.indexOf('platforms/chatgpt/content.js');

  if (dedupeIndex === -1) {
    log(`❌ Manifest: deduplication.js not in content_scripts`, 'red');
    return false;
  }

  if (contentIndex === -1) {
    log(`❌ Manifest: content.js not in content_scripts`, 'red');
    return false;
  }

  if (dedupeIndex < contentIndex) {
    log(`✅ Manifest: Load order correct (deduplication.js before content.js)`, 'green');
    return true;
  } else {
    log(`❌ Manifest: Load order WRONG (deduplication.js must load before content.js)`, 'red');
    return false;
  }
}

// Main verification
log('\n' + '='.repeat(60), 'bold');
log('WebSocket + Deduplication Implementation Verification', 'bold');
log('='.repeat(60) + '\n', 'bold');

let allPassed = true;

// 1. Check files exist
log('\n📁 File Existence Checks:', 'blue');
allPassed &= checkFileExists('platforms/chatgpt/inject.js', 'ChatGPT inject script');
allPassed &= checkFileExists('platforms/chatgpt/content.js', 'ChatGPT content script');
allPassed &= checkFileExists('platforms/chatgpt/deduplication.js', 'Deduplication module');
allPassed &= checkFileExists('manifest.json', 'Extension manifest');
allPassed &= checkFileExists('TEST_WEBSOCKET_DEDUPLICATION.md', 'Test procedures');
allPassed &= checkFileExists('QUICK_TEST_GUIDE.md', 'Quick test guide');

// 2. Check WebSocket interception in inject.js
log('\n🎤 WebSocket Interception Checks:', 'blue');
allPassed &= checkFileContains('platforms/chatgpt/inject.js', [
  'const OriginalWebSocket = window.WebSocket',
  'window.WebSocket = function(...args)',
  'wsUrl.includes(\'ws.chatgpt.com\')',
  'captureMethod: \'websocket\'',
  'Voice transcript captured'
], 'WebSocket wrapper implementation');

// 3. Check deduplication layer
log('\n🔄 Deduplication Layer Checks:', 'blue');
allPassed &= checkFileContains('platforms/chatgpt/deduplication.js', [
  'class MessageDeduplicator',
  'shouldCapture(content, captureMethod)',
  'getConfidence(method)',
  'hashContent(content)',
  'window.KYT_Deduplicator = new MessageDeduplicator()'
], 'Deduplication class implementation');

// 4. Check deduplication integration in content.js
log('\n🔗 Deduplication Integration Checks:', 'blue');
allPassed &= checkFileContains('platforms/chatgpt/content.js', [
  'const deduplicator = window.KYT_Deduplicator',
  'deduplicator.shouldCapture(messageData.content, captureMethod)',
  'Duplicate message skipped by deduplicator'
], 'Content script integration');

// 5. Check enhanced DOM fallback
log('\n🧩 Enhanced DOM Fallback Checks:', 'blue');
allPassed &= checkFileContains('platforms/chatgpt/inject.js', [
  'const MESSAGE_SELECTORS = [',
  'const NOISE_PATTERNS = [',
  'function isNoiseElement(node)',
  'captureMethod: \'dom\''
], 'DOM fallback enhancements');

// 6. Check manifest load order
log('\n📋 Manifest Configuration Checks:', 'blue');
allPassed &= checkManifestLoadOrder();

// Summary
log('\n' + '='.repeat(60), 'bold');
if (allPassed) {
  log('✅ ALL CHECKS PASSED - Implementation Complete!', 'green');
  log('\nNext Steps:', 'blue');
  log('1. Reload Chrome extension (chrome://extensions)', 'reset');
  log('2. Run QUICK_TEST_GUIDE.md (5-minute validation)', 'reset');
  log('3. Run TEST_WEBSOCKET_DEDUPLICATION.md (comprehensive)', 'reset');
} else {
  log('❌ SOME CHECKS FAILED - Review issues above', 'red');
  log('\nFix the failed checks before testing', 'yellow');
}
log('='.repeat(60) + '\n', 'bold');

process.exit(allPassed ? 0 : 1);
