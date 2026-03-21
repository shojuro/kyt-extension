#!/usr/bin/env node

/**
 * K.Y.T. UserPromptSubmit Hook — Smart Gating Edition
 *
 * Fires before every user prompt reaches Claude Code.
 * Gates:
 *   1. Memory mode (incognito/clean_room → skip)
 *   2. Length < 8 chars → skip
 *   3. Code-block dominated (>70% code) → skip
 *   4. Intent classifier SKIP → skip (~0.06ms, 90% of prompts)
 *   5. Recency cache (similar query <30s ago) → skip
 *
 * Only ~10% of prompts proceed to search_memories (fast mode, <300ms).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { classifyIntent, scoreTemporalReference, scoreSynthesisIntent } from '../lib/intent-classifier.js';
import { extractPlatformMention } from '../lib/platform-utils.js';

// ── Inline config reading (no heavy imports for speed) ──────

function getMemoryMode() {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.kyt', 'config.json'), 'utf-8'));
    return config.memoryMode || 'full';
  } catch {
    return 'full';
  }
}

// ── .env loader ─────────────────────────────────────────────

function loadEnv() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const mcpDir = join(scriptDir, '..', '..');

  const envPaths = [
    join(mcpDir, '.env'),
    join(process.cwd(), 'mcp', '.env'),
    join(process.cwd(), '.env'),
    join(homedir(), '.kyt', '.env'),
  ];

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

// ── Recency cache ───────────────────────────────────────────

const CACHE_PATH = join(homedir(), '.kyt', 'hook-cache.json');
const COOLDOWN_MS = 30000; // 30 seconds

function readCache() {
  try { return JSON.parse(readFileSync(CACHE_PATH, 'utf-8')); } catch { return {}; }
}

function writeCache(data) {
  try {
    const dir = join(homedir(), '.kyt');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(data));
  } catch { /* non-critical */ }
}

/**
 * Simple word-overlap similarity (Jaccard-like, no external deps).
 * Returns 0.0–1.0.
 */
function computeSimilarity(a, b) {
  const stopWords = new Set(['the','a','an','is','are','was','were','be','been','being',
    'have','has','had','do','does','did','will','would','could','should','can',
    'to','of','in','for','on','with','at','by','from','and','or','but','not','this','that']);
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w)));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w)));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  return intersection / Math.max(wordsA.size, wordsB.size);
}

// ── Debugging intent detection ───────────────────────────────

const DEBUG_KEYWORDS = /\b(error|bug|fix|debug|broken|failed|not working|wrong|issue|crash|exception|undefined|null|NaN|unexpected|missing|empty|stuck|infinite|timeout|rejected|refused|denied|parse|decode)\b/i;
const DEBUG_PATTERNS = /\b(why is .+ returning|doesn't work|getting error|returns empty|returns null|not showing|can't find|not found|keeps failing)\b/i;

function scoreDebuggingIntent(text) {
  let score = 0;
  if (DEBUG_KEYWORDS.test(text)) score = Math.max(score, 0.5);
  if (DEBUG_PATTERNS.test(text)) score = Math.max(score, 0.7);
  // "have I seen this before" / "lesson" / "learned" → strong signal
  if (/\b(seen this before|lesson|learned|same issue|same error|same problem)\b/i.test(text)) score = Math.max(score, 0.8);
  return score;
}

// ── Lessons notebook query ──────────────────────────────────

async function queryLessonsNotebook(prompt, classification) {
  // Only query if debugging intent is detected
  const debugScore = scoreDebuggingIntent(prompt);
  if (debugScore < 0.5) return null;

  // Read lessons notebook ID from config
  let lessonsNotebookId;
  try {
    const nlmConfig = JSON.parse(readFileSync(join(homedir(), '.kyt', 'notebooklm.json'), 'utf-8'));
    lessonsNotebookId = nlmConfig.lessonsNotebookId;
  } catch { return null; }
  if (!lessonsNotebookId) return null;

  // Check if NotebookLM passphrase is available
  const passphrase = process.env.NOTEBOOKLM_PASSPHRASE;
  if (!passphrase) return null;

  // Check if auth file exists
  const authPath = join(homedir(), '.kyt', 'notebooklm-auth.enc');
  if (!existsSync(authPath)) return null;

  try {
    // Dynamic import to avoid loading heavy NotebookLM client on every hook run
    const { askQuestion, setPassphrase, hasPassphrase } = await import('../lib/notebooklm-client.js');
    if (!hasPassphrase()) setPassphrase(passphrase);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s max for lessons query

    const { answer } = await askQuestion(lessonsNotebookId, prompt.substring(0, 300));
    clearTimeout(timeout);

    if (!answer || answer.length < 20) return null;

    // Truncate to keep token cost low
    const truncated = answer.length > 500 ? answer.substring(0, 500) + '...' : answer;
    return `[K.Y.T. Lessons — past debugging insights (score: ${(debugScore * 100).toFixed(0)}%)]\n${truncated}`;
  } catch (err) {
    process.stderr.write(`KYT hook: lessons query failed: ${err.message}\n`);
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  // Read stdin JSON
  let input;
  try {
    const raw = readFileSync(0, 'utf-8');
    input = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`KYT hook: failed to parse stdin: ${err.message}\n`);
    process.exit(0);
  }

  // ── Catch-up: ingest missed sessions (once per session) ──
  const sessionId = input.session_id || '';
  const catchUpFlag = join(homedir(), '.kyt', `catch-up-${sessionId.slice(0, 8)}.flag`);
  if (sessionId && !existsSync(catchUpFlag)) {
    try {
      const kytDir = join(homedir(), '.kyt');
      if (!existsSync(kytDir)) mkdirSync(kytDir, { recursive: true });
      writeFileSync(catchUpFlag, new Date().toISOString());
      const scriptDir = dirname(fileURLToPath(import.meta.url));
      const catchUpScript = join(scriptDir, 'catch-up-ingest.js');
      if (existsSync(catchUpScript)) {
        const child = spawn('node', [catchUpScript, sessionId], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
      }
    } catch { /* non-critical */ }
  }

  const prompt = input.prompt;
  if (!prompt || typeof prompt !== 'string') {
    process.exit(0);
  }

  const trimmed = prompt.trim();

  // ── Gate 1: Length ────────────────────────────────────────
  if (trimmed.length < 8) {
    process.exit(0);
  }

  // ── Gate 2: Code-block dominated ─────────────────────────
  const codeBlocks = trimmed.match(/```[\s\S]*?```/g) || [];
  const codeLength = codeBlocks.reduce((sum, block) => sum + block.length, 0);
  if (codeLength > 0 && codeLength / trimmed.length > 0.7) {
    process.stderr.write('KYT hook: SKIP (code_dominated)\n');
    process.exit(0);
  }

  // ── Gate 3: Intent classifier (~0.06ms) ──────────────────
  const classification = classifyIntent(trimmed);
  if (classification.intent === 'SKIP') {
    process.stderr.write(`KYT hook: SKIP (${classification.reason})\n`);
    process.exit(0);
  }

  // ── Gate 4: Memory mode ──────────────────────────────────
  const mode = getMemoryMode();
  if (mode !== 'full') {
    process.exit(0);
  }

  // ── Gate 5: Recency cache ────────────────────────────────
  const now = Date.now();
  const cache = readCache();
  if (cache.lastQuery && cache.lastTimestamp &&
      (now - cache.lastTimestamp) < COOLDOWN_MS &&
      computeSimilarity(trimmed, cache.lastQuery) > 0.8) {
    process.stderr.write('KYT hook: SKIP (cooldown)\n');
    process.exit(0);
  }

  // ── Load env and search ──────────────────────────────────
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
    const timeout = setTimeout(() => controller.abort(), 20000);

    // Temporal+platform detection: if user asks about a specific platform
    // with temporal intent, use recentByPlatform for fast recency path
    // Read active project from config
    let activeProjectId = null;
    try {
      const config = JSON.parse(readFileSync(join(homedir(), '.kyt', 'config.json'), 'utf-8'));
      activeProjectId = config.activeProjectId || null;
    } catch { /* no active project */ }

    const searchBody = {
      query: trimmed.substring(0, 500),
      userId,
      useHyde: false,
      topK: 3,
      fast: true,
      confidenceThreshold: classification.confidenceThreshold || 0.40,
    };
    if (activeProjectId) searchBody.projectId = activeProjectId;
    const temporalScore = scoreTemporalReference(trimmed.toLowerCase());
    const targetPlatform = extractPlatformMention(trimmed);
    if (temporalScore >= 0.4 && targetPlatform) {
      searchBody.recentByPlatform = targetPlatform;
    }
    if (classification.scores?.synthesis > 0.4) {
      searchBody.mmrLambda = 0.35;
    }

    const res = await fetch(`${supabaseUrl}/functions/v1/search_memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey': process.env.SUPABASE_ANON_KEY || token,
      },
      body: JSON.stringify(searchBody),
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
      // Update cache even on empty results to prevent re-searching
      writeCache({ lastQuery: trimmed, lastTimestamp: now, lastResultCount: 0 });
      process.exit(0);
    }

    // Update recency cache
    writeCache({ lastQuery: trimmed, lastTimestamp: now, lastResultCount: results.length });

    // ── Format context as compact JSON (token-optimized) ────
    // ~70% smaller than natural language format.
    // Claude parses kyt.items for memory, kyt.lessons for debugging insights.
    const kytItems = results.map(r => {
      const snippet = (r.content || '').substring(0, 100).replace(/\n/g, ' ');
      return {
        s: r.similarity ? Math.round(r.similarity * 100) : 0,
        p: r.platform || '',
        t: snippet,
      };
    });

    const kytContext = { v: 1, n: results.length, items: kytItems };

    // ── Lessons notebook query (on debugging intent) ────────
    const lessonsResult = await queryLessonsNotebook(trimmed, classification);
    if (lessonsResult) {
      // Extract just the answer text, truncated
      const lessonText = lessonsResult.replace(/^\[K\.Y\.T\. Lessons[^\]]*\]\n?/, '').substring(0, 300);
      kytContext.lessons = { s: scoreDebuggingIntent(trimmed) * 100 | 0, t: lessonText };
    }

    // Build the output — verify valid JSON before emitting
    let context;
    try {
      const jsonStr = JSON.stringify(kytContext);
      JSON.parse(jsonStr); // verify roundtrip (H1 mitigation)
      context = `[KYT:v1] ${jsonStr}`;
    } catch {
      // Fallback to natural language on JSON error (M1 mitigation)
      process.stderr.write('KYT hook: JSON format failed, falling back to text\n');
      const textItems = results.map((r, i) => {
        const plat = r.platform ? `[${r.platform}]` : '';
        const score = r.similarity ? `${(r.similarity * 100).toFixed(0)}%` : '';
        const snippet = (r.content || '').substring(0, 100);
        return `${i + 1}. ${plat} ${score}: ${snippet}`;
      }).join('\n');
      context = `[K.Y.T. Memory Context — ${results.length} items]\n${textItems}`;
    }

    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    });

    // Log expanded version for debugging (L1 mitigation)
    process.stderr.write(`KYT hook: injecting ${kytContext.n} items (JSON format, ${context.length} chars)\n`);

    process.stdout.write(output);
    process.exit(0);

  } catch (err) {
    if (err.name === 'AbortError') {
      process.stderr.write('KYT hook: search timed out (20s)\n');
    } else {
      process.stderr.write(`KYT hook: ${err.message}\n`);
    }
    process.exit(0);
  }
}

main();
