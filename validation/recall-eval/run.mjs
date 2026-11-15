#!/usr/bin/env node
/**
 * Run a recall test set against the live search, the way the extension does.
 *
 *   node --env-file=.env validation/recall-eval/run.mjs <set.json> [--dry] [--limit N] [--label text]
 *
 * Reads SUPABASE_URL, SUPABASE_SERVICE_KEY and USER_ID from the environment
 * and never prints them. --dry checks the set file and makes no request.
 * Each question costs one search (an embedding and, when sections match, one
 * small model call). Results go next to the set, in results/.
 *
 * This touches the live database (read-only searches). Run it only with the
 * owner's go.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { validateSet, scoreQuestion, summarise, compareRuns } from '../../src/recall-eval-lib.js';
import { classifyIntent } from '../../src/intent-classifier.js';

const args = process.argv.slice(2);
const setPath = args.find((a) => !a.startsWith('--'));
const flag = (name) => args.includes(`--${name}`);
const valueOf = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
if (!setPath) { console.error('usage: run.mjs <set.json> [--dry] [--limit N] [--label text]'); process.exit(2); }

const set = JSON.parse(readFileSync(setPath, 'utf8'));
const problems = validateSet(set);
if (problems.length > 0) { console.error(`Set has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`); process.exit(1); }
const limit = Number(valueOf('limit')) || set.questions.length;
const questions = set.questions.slice(0, limit);
console.log(`Set OK: ${set.questions.length} questions (${questions.length} to run).`);
if (flag('dry')) process.exit(0);

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
const userId = process.env.USER_ID;
if (!url || !key || !userId) { console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_KEY or USER_ID in the environment.'); process.exit(2); }

const DEFAULT_THRESHOLD = 0.4;
const scoreOf = (r) => r.cross_encoder_score ?? r.weighted_score ?? 0;

async function search(question) {
  const intent = classifyIntent(question);
  if (intent.intent === 'SKIP') return { skipped: true, results: [], ms: 0, intent: intent.reason };
  const threshold = intent.confidenceThreshold ?? DEFAULT_THRESHOLD;
  const started = Date.now();
  const res = await fetch(`${url}/functions/v1/search_memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, apikey: key },
    body: JSON.stringify({ query: question, userId, topK: 25, fast: true, confidenceThreshold: intent.confidenceThreshold ?? undefined }),
    signal: AbortSignal.timeout(45000),
  });
  const ms = Date.now() - started;
  if (!res.ok) throw new Error(`search returned ${res.status}`);
  const data = await res.json();
  const results = (Array.isArray(data.results) ? data.results : []).filter((r) => scoreOf(r) >= threshold);
  return { skipped: false, results, ms, intent: intent.reason };
}

const scores = [];
for (const q of questions) {
  try {
    const out = await search(q.question);
    const score = { ...scoreQuestion(q, out.results, { skipped: out.skipped }), ms: out.ms, intent: out.intent };
    scores.push(score);
    console.log(`${score.pass ? 'PASS' : 'FAIL'}  ${q.id}  returned=${score.returned} rank=${score.rank ?? '-'} ${out.skipped ? '(not searched)' : `${out.ms}ms`}`);
  } catch (e) {
    scores.push({ id: q.id, kind: q.kind, pass: false, returned: 0, rank: null, skipped: false, wanted: q.expect?.none ? 'nothing' : 'answer', error: String(e.message).slice(0, 120) });
    console.log(`ERROR ${q.id}  ${String(e.message).slice(0, 120)}`);
  }
}

const summary = summarise(scores);
const outDir = join(dirname(setPath), 'results');
mkdirSync(outDir, { recursive: true });
const previous = readdirSync(outDir).filter((f) => f.startsWith(basename(setPath, '.json'))).sort().pop();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(outDir, `${basename(setPath, '.json')}-${stamp}.json`);
writeFileSync(outPath, JSON.stringify({ label: valueOf('label') ?? null, ran_at: new Date().toISOString(), summary, scores }, null, 2));
console.log('\nSummary:', JSON.stringify(summary.overall));
for (const [kind, t] of Object.entries(summary.by_kind)) console.log(`  ${kind}: ${t.passed}/${t.questions}`);
if (previous) {
  const diff = compareRuns(JSON.parse(readFileSync(join(outDir, previous), 'utf8')).scores, scores);
  console.log(`\nAgainst ${previous}: fixed ${diff.fixed.length} [${diff.fixed.join(', ')}], broken ${diff.broken.length} [${diff.broken.join(', ')}]`);
}
console.log(`\nSaved: ${outPath}`);
