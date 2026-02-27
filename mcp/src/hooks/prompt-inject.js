#!/usr/bin/env node

/**
 * K.Y.T. UserPromptSubmit Hook
 *
 * Fires before every user prompt reaches Claude Code.
 * Reads the user's prompt from stdin JSON, queries K.Y.T. memory,
 * and outputs relevant context to stdout for injection.
 *
 * Respects memory mode: incognito/clean_room = no injection.
 * Lightweight search: no HyDE, topK=3 for speed (<2s target).
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// Inline config reading (no heavy imports for speed)
function getMemoryMode() {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.kyt', 'config.json'), 'utf-8'));
    return config.memoryMode || 'full';
  } catch {
    return 'full';
  }
}

// Read .env manually (no dotenv import for speed)
function loadEnv() {
  // Resolve the mcp/ directory relative to this script file
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const mcpDir = join(scriptDir, '..', '..');

  const envPaths = [
    join(mcpDir, '.env'),                    // mcp/.env (relative to this script)
    join(process.cwd(), 'mcp', '.env'),      // cwd/mcp/.env
    join(process.cwd(), '.env'),             // cwd/.env
    join(homedir(), '.kyt', '.env'),         // ~/.kyt/.env
  ];

  // Also check CLAUDE_PROJECT_DIR
  if (process.env.CLAUDE_PROJECT_DIR) {
    envPaths.unshift(join(process.env.CLAUDE_PROJECT_DIR, 'mcp', '.env'));
  }

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      const lines = readFileSync(envPath, 'utf-8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      break;
    }
  }
}

async function main() {
  // Read stdin JSON
  let input;
  try {
    const raw = readFileSync(0, 'utf-8');
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`KYT hook: failed to parse stdin: ${err.message}\n`);
    process.exit(0); // Non-blocking — don't break the prompt
  }

  const prompt = input.prompt;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 5) {
    process.exit(0); // Too short to search meaningfully
  }

  // Check memory mode
  const mode = getMemoryMode();
  if (mode !== 'full') {
    process.exit(0); // No injection in clean_room or incognito
  }

  // Load env vars
  loadEnv();

  const supabaseUrl = process.env.SUPABASE_URL;
  const token = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  const userId = process.env.KYT_USER_ID;

  if (!supabaseUrl || !token || !userId) {
    process.stderr.write('KYT hook: missing env vars (SUPABASE_URL, auth key, or KYT_USER_ID)\n');
    process.exit(0);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000); // 20s hard timeout (search_memories pipeline is ~13-15s)

    const res = await fetch(`${supabaseUrl}/functions/v1/search_memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_ANON_KEY || token,
      },
      body: JSON.stringify({
        query: prompt.trim().substring(0, 500), // Cap query length
        userId,
        useHyde: false,  // Skip HyDE for speed
        topK: 3,         // Lightweight results
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      process.stderr.write(`KYT hook: search returned ${res.status}\n`);
      process.exit(0);
    }

    const data = await res.json();
    const results = data.results || [];

    if (results.length === 0) {
      process.exit(0); // No relevant context to inject
    }

    // Format context for injection
    const contextItems = results.map((r, i) => {
      const plat = r.platform ? `[${r.platform}]` : '';
      const score = r.similarity ? `${(r.similarity * 100).toFixed(0)}%` : '';
      const snippet = (r.content || '').substring(0, 200);
      return `${i + 1}. ${plat} ${score}: ${snippet}`;
    }).join('\n');

    const context = `[K.Y.T. Memory Context — ${results.length} relevant items from past conversations]\n${contextItems}`;

    // Output as JSON with additionalContext for discrete injection
    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    });

    process.stdout.write(output);
    process.exit(0);

  } catch (err) {
    if (err.name === 'AbortError') {
      process.stderr.write('KYT hook: search timed out (20s)\n');
    } else {
      process.stderr.write(`KYT hook: ${err.message}\n`);
    }
    process.exit(0); // Never block the prompt
  }
}

main();
