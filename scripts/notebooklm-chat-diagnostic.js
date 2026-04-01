#!/usr/bin/env node
/**
 * NotebookLM Chat API Diagnostic — captures the exact request format
 * used by the NotebookLM web UI when asking a question in chat.
 *
 * Purpose: The MCP server's askQuestion() returns error code [16].
 * This script captures a WORKING request from the real browser UI
 * to identify what params format the current API expects.
 *
 * Usage:
 *   node scripts/notebooklm-chat-diagnostic.js [notebookId]
 *
 * If no notebookId is provided, it opens the NotebookLM homepage
 * and you can navigate to any notebook manually.
 *
 * Output:
 *   - Captured request: URL, headers, body (f.req decoded)
 *   - Captured response: status, body preview
 *   - Diff against current askQuestion() format
 *   - Saved to scripts/nlm-chat-capture.json for reference
 */

import { chromium } from 'playwright';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
const envPath = resolve(__dirname, '../mcp/.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
} catch { /* no .env */ }

// Load existing cookies for auto-login
const authModule = resolve(__dirname, '../mcp/src/lib/notebooklm-auth.js');
const { loadCookies, isAuthConfigured } = await import(authModule);

const NOTEBOOKLM_URL = 'https://notebooklm.google.com';
const notebookId = process.argv[2] || null;
const targetUrl = notebookId
  ? `${NOTEBOOKLM_URL}/notebook/${notebookId}`
  : NOTEBOOKLM_URL;

console.log('');
console.log('🔍 NotebookLM Chat API Diagnostic');
console.log('──────────────────────────────────');
console.log(`Target: ${targetUrl}`);
console.log('');
console.log('Instructions:');
console.log('1. A browser will open (with your existing cookies if available)');
console.log('2. Navigate to a notebook if needed');
console.log('3. Type a question in the chat and send it');
console.log('4. The script will capture the API request and response');
console.log('5. Results saved to scripts/nlm-chat-capture.json');
console.log('');

// ── Connect to existing Chrome or launch with user profile ──────────────
let browser, context, page;

const CDP_URL = process.env.CDP_URL || 'http://localhost:9222';
const useCDP = process.argv.includes('--cdp');
const chromeProfilePath = process.env.CHROME_PROFILE_PATH;

if (useCDP) {
  // Option A: Connect to existing Chrome via CDP
  // User must start Chrome with: chrome.exe --remote-debugging-port=9222
  console.log(`🔌 Connecting to Chrome via CDP at ${CDP_URL}...`);
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
    const contexts = browser.contexts();
    context = contexts[0] || await browser.newContext();
    // Use existing page or create new one
    const pages = context.pages();
    page = pages[0] || await context.newPage();
    console.log('✅ Connected to existing Chrome session');
  } catch (e) {
    console.error(`❌ Could not connect to Chrome CDP at ${CDP_URL}`);
    console.error('');
    console.error('Start Chrome with remote debugging:');
    console.error('  Windows: chrome.exe --remote-debugging-port=9222');
    console.error('  macOS:   /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222');
    console.error('  Linux:   google-chrome --remote-debugging-port=9222');
    console.error('');
    console.error('Then re-run: node scripts/notebooklm-chat-diagnostic.js --cdp [notebookId]');
    process.exit(1);
  }
} else if (chromeProfilePath) {
  // Option B: Launch Chromium with existing Chrome profile (preserves all cookies)
  console.log(`📂 Launching with Chrome profile: ${chromeProfilePath}`);
  browser = await chromium.launchPersistentContext(chromeProfilePath, {
    headless: false,
    channel: 'chrome', // Use system Chrome, not Playwright's Chromium
  });
  context = browser;
  page = context.pages()[0] || await context.newPage();
} else {
  // Option C: Fresh browser with saved cookies (may trigger Google abuse detection)
  console.log('🌐 Launching fresh browser (Google may block sign-in)');
  console.log('   Tip: Use --cdp to connect to your existing Chrome instead:');
  console.log('   1. Close Chrome fully');
  console.log('   2. Relaunch: chrome.exe --remote-debugging-port=9222');
  console.log('   3. Re-run: node scripts/notebooklm-chat-diagnostic.js --cdp [notebookId]');
  console.log('');
  browser = await chromium.launch({ headless: false });
  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  // Inject existing cookies if available
  if (isAuthConfigured()) {
    try {
      const passphrase = process.env.NOTEBOOKLM_PASSPHRASE || undefined;
      const savedCookies = loadCookies(passphrase);
      if (savedCookies && savedCookies.length > 0) {
        const playwrightCookies = savedCookies.map(c => ({
          name: c.name,
          value: c.value,
          domain: c.domain || '.google.com',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'None',
        }));
        await context.addCookies(playwrightCookies);
        console.log(`🍪 Loaded ${playwrightCookies.length} existing cookies`);
      }
    } catch (e) {
      console.warn(`⚠️ Could not load existing cookies: ${e.message}`);
    }
  }
  page = await context.newPage();
}

// ── Intercept network requests ──────────────────────────────────────────
const captures = [];
let streamingCapture = null;
let batchCaptures = [];

// Capture ALL requests to LabsTailwindUi endpoints
page.on('request', async (request) => {
  const url = request.url();

  // Capture streaming (chat) requests
  if (url.includes('GenerateFreeFormStreamed') || url.includes('GenerateFreeForm')) {
    const postData = request.postData();
    const headers = request.headers();

    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log('🎯 CAPTURED: Chat/Streaming Request');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`URL: ${url}`);
    console.log(`Method: ${request.method()}`);
    console.log('');

    // Parse f.req from URL-encoded body
    let fReqRaw = null;
    let fReqDecoded = null;
    let csrfToken = null;
    if (postData) {
      const params = new URLSearchParams(postData);
      fReqRaw = params.get('f.req');
      csrfToken = params.get('at');
      if (fReqRaw) {
        try {
          fReqDecoded = JSON.parse(fReqRaw);
        } catch {
          fReqDecoded = fReqRaw;
        }
      }
    }

    // Parse query string
    const urlObj = new URL(url);
    const queryParams = Object.fromEntries(urlObj.searchParams.entries());

    streamingCapture = {
      url,
      method: request.method(),
      queryParams,
      headers: {
        'Content-Type': headers['content-type'],
        'Authorization': headers['authorization'] ? headers['authorization'].substring(0, 30) + '...' : null,
        'Origin': headers['origin'],
        'Referer': headers['referer'],
        'Cookie': headers['cookie'] ? `[${headers['cookie'].length} chars]` : null,
      },
      body: {
        raw: postData ? postData.substring(0, 500) : null,
        fReqRaw: fReqRaw ? fReqRaw.substring(0, 1000) : null,
        fReqDecoded,
        csrfToken: csrfToken ? csrfToken.substring(0, 20) + '...' : null,
      },
    };

    // Pretty print the decoded f.req
    console.log('── Query String ──');
    console.log(JSON.stringify(queryParams, null, 2));
    console.log('');
    console.log('── f.req (decoded) ──');
    console.log(JSON.stringify(fReqDecoded, null, 2));
    console.log('');

    // Extract the inner params (the part we need to match)
    if (fReqDecoded && Array.isArray(fReqDecoded)) {
      // fReq is typically [null, paramsJsonString] or [[methodId, paramsJson, ...]]
      let innerParams = null;
      if (fReqDecoded[1] && typeof fReqDecoded[1] === 'string') {
        try {
          innerParams = JSON.parse(fReqDecoded[1]);
        } catch { /* not JSON */ }
      } else if (fReqDecoded[0] && Array.isArray(fReqDecoded[0])) {
        // batchexecute format
        const inner = fReqDecoded[0][0];
        if (inner && inner[1] && typeof inner[1] === 'string') {
          try {
            innerParams = JSON.parse(inner[1]);
          } catch { /* not JSON */ }
        }
      }

      if (innerParams) {
        console.log('── Inner Params (the params array) ──');
        console.log(JSON.stringify(innerParams, null, 2));
        streamingCapture.innerParams = innerParams;

        // Compare with our current format
        console.log('');
        console.log('── COMPARISON WITH CURRENT askQuestion() ──');
        const ourParams = [
          [], // sources (empty = use all)
          '<question>',
          null, // no conversation history
          [2, null, [1], [1]],
          null, // no conversation ID
          null,
          null,
          '<notebookId>',
          1,
        ];
        console.log('OUR FORMAT:');
        console.log(JSON.stringify(ourParams, null, 2));
        console.log('');
        console.log('BROWSER FORMAT:');
        // Redact the question and notebook ID for readability
        const redacted = JSON.parse(JSON.stringify(innerParams));
        console.log(JSON.stringify(redacted, null, 2));
        console.log('');
        console.log(`Param count: ours=${ourParams.length} browser=${innerParams.length}`);
      }
    }
  }

  // Also capture batchexecute requests for comparison
  if (url.includes('batchexecute') && url.includes('LabsTailwindUi')) {
    const postData = request.postData();
    if (postData) {
      const params = new URLSearchParams(postData);
      const fReq = params.get('f.req');
      const urlObj = new URL(url);
      const rpcids = urlObj.searchParams.get('rpcids');
      batchCaptures.push({
        rpcids,
        queryParams: Object.fromEntries(urlObj.searchParams.entries()),
        fReqPreview: fReq ? fReq.substring(0, 200) : null,
      });
    }
  }
});

// Capture responses for the streaming endpoint
page.on('response', async (response) => {
  const url = response.url();
  if (url.includes('GenerateFreeFormStreamed') || url.includes('GenerateFreeForm')) {
    try {
      const status = response.status();
      const body = await response.text();
      console.log('');
      console.log('── Response ──');
      console.log(`Status: ${status}`);
      console.log(`Body length: ${body.length}`);
      console.log(`Body preview: ${body.substring(0, 500)}`);

      if (streamingCapture) {
        streamingCapture.response = {
          status,
          bodyLength: body.length,
          bodyPreview: body.substring(0, 2000),
        };
      }
    } catch (e) {
      console.warn(`Could not read response: ${e.message}`);
    }
  }
});

// ── Navigate and wait ───────────────────────────────────────────────────
try {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.log('✅ Page loaded. Ask a question in the notebook chat.');
  console.log('   (The script will capture the request automatically)');
  console.log('   Press Ctrl+C to stop after capturing.');
  console.log('');

  // Wait for user to interact — keep alive for 5 minutes
  await page.waitForTimeout(300000);

} catch (e) {
  if (e.message.includes('Target closed') || e.message.includes('Browser has been closed')) {
    console.log('Browser closed.');
  } else {
    console.error('Error:', e.message);
  }
} finally {
  // Save captures
  const output = {
    timestamp: new Date().toISOString(),
    streamingCapture,
    batchCaptures: batchCaptures.slice(0, 10), // limit
  };

  const outputPath = resolve(__dirname, 'nlm-chat-capture.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('');
  console.log(`💾 Capture saved to: ${outputPath}`);

  if (streamingCapture?.innerParams) {
    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log('📋 NEXT STEPS');
    console.log('═══════════════════════════════════════════════════════');
    console.log('1. Compare innerParams above with askQuestion() in');
    console.log('   mcp/src/lib/notebooklm-client.js line 475-485');
    console.log('2. Update the params array to match the browser format');
    console.log('3. Check if fReq wrapper format changed');
    console.log('4. Check if query string needs additional params');
    console.log('5. Test with: node -e "import {askQuestion} from ...');
  } else {
    console.log('');
    console.log('⚠️ No streaming request captured.');
    console.log('   Make sure you asked a question in the notebook chat.');
  }

  await browser.close();
}
