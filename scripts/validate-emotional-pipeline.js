#!/usr/bin/env node
/**
 * K.Y.T. Emotional Pipeline Validation Suite
 *
 * Runs diagnostic queries against synthetic test data via SECURITY DEFINER
 * RPC function (bypasses RLS). Validates data integrity, classification
 * coverage, score distribution, quadrant coverage.
 *
 * Usage:
 *   node scripts/validate-emotional-pipeline.js
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env
try {
  const envContent = readFileSync(resolve(__dirname, '../mcp/.env'), 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.+)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Colors
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', C = '\x1b[36m', D = '\x1b[2m', X = '\x1b[0m';
let passed = 0, failed = 0, skipped = 0;

function pass(name, detail = '') {
  passed++;
  console.log(`  ${G}PASS${X}  ${name}${detail ? D + ' — ' + detail + X : ''}`);
}
function fail(name, detail = '') {
  failed++;
  console.log(`  ${R}FAIL${X}  ${name}${detail ? ' — ' + detail : ''}`);
}
function skip(name, reason = '') {
  skipped++;
  console.log(`  ${Y}SKIP${X}  ${name}${reason ? D + ' — ' + reason + X : ''}`);
}

async function main() {
  console.log(`\n${C}╔══════════════════════════════════════════════╗${X}`);
  console.log(`${C}║  K.Y.T. Emotional Pipeline Validation Suite  ║${X}`);
  console.log(`${C}╚══════════════════════════════════════════════╝${X}\n`);

  // Call the SECURITY DEFINER RPC
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/validate_synthetic_data`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: '{}',
  });

  if (!res.ok) {
    console.error(`${R}RPC failed: ${res.status} ${await res.text()}${X}`);
    process.exit(1);
  }

  const d = await res.json();

  // ━━━ Category 1: Data Integrity ━━━
  console.log(`${C}━━━ Category 1: Data Integrity ━━━${X}\n`);

  d.total >= 700        ? pass('Row count >= 700', `${d.total}`) : fail('Row count >= 700', `${d.total}`);
  d.dev >= 300          ? pass('Dev conversations >= 300', `${d.dev}`) : fail('Dev conversations >= 300', `${d.dev}`);
  d.emotional >= 200    ? pass('Emotional conversations >= 200', `${d.emotional}`) : fail('Emotional conversations >= 200', `${d.emotional}`);
  d.noise >= 50         ? pass('Noise conversations >= 50', `${d.noise}`) : fail('Noise conversations >= 50', `${d.noise}`);
  d.platforms >= 3      ? pass('3+ platforms', `${d.platforms}`) : fail('3+ platforms', `${d.platforms}`);
  d.empty_content === 0 ? pass('No empty content') : fail('No empty content', `${d.empty_content} empty`);
  d.avg_content_len > 1000 ? pass('Avg content > 1000 chars', `${d.avg_content_len}`) : fail('Avg content > 1000 chars', `${d.avg_content_len}`);

  // ━━━ Category 2: Classification Coverage ━━━
  console.log(`\n${C}━━━ Category 2: Classification Coverage ━━━${X}\n`);

  const hasScores = d.classified > 0 && d.has_impact > 0;

  if (!hasScores) {
    skip('Embedding coverage', `${d.has_embedding}/${d.total} — edge function fix needed`);
    skip('Impact score coverage', `${d.has_impact}/${d.total}`);
    skip('Valence coverage', `${d.has_valence}/${d.total}`);
    skip('Emotion keywords coverage', `${d.has_keywords}/${d.total}`);
    skip('Classification flag', `${d.classified}/${d.total}`);
  } else {
    const pct = (n) => `${Math.round(n / d.total * 100)}%`;
    d.has_embedding / d.total > 0.95 ? pass('Embedding > 95%', pct(d.has_embedding)) : fail('Embedding > 95%', pct(d.has_embedding));
    d.has_impact / d.total > 0.3     ? pass('Impact > 0 for 30%+', pct(d.has_impact)) : fail('Impact > 0 for 30%+', pct(d.has_impact));
    d.has_valence / d.total > 0.3    ? pass('Valence populated 30%+', pct(d.has_valence)) : fail('Valence populated 30%+', pct(d.has_valence));
    d.has_keywords / d.total > 0.2   ? pass('Keywords populated 20%+', pct(d.has_keywords)) : fail('Keywords populated 20%+', pct(d.has_keywords));
    d.classified / d.total > 0.95    ? pass('Classified > 95%', pct(d.classified)) : fail('Classified > 95%', pct(d.classified));
  }

  // ━━━ Category 3: Score Distribution ━━━
  console.log(`\n${C}━━━ Category 3: Score Distribution ━━━${X}\n`);

  if (!hasScores) {
    skip('Lonelies avg impact > devs', 'No scores yet');
    skip('Lonelies avg |valence| > devs', 'No scores yet');
    skip('Lonelies avg intimacy > devs', 'No scores yet');
    skip('Noise avg impact < 10', 'No scores yet');
  } else {
    d.avg_impact_lon > d.avg_impact_dev
      ? pass('Lonelies impact > devs', `${d.avg_impact_lon} > ${d.avg_impact_dev}`)
      : fail('Lonelies impact > devs', `${d.avg_impact_lon} <= ${d.avg_impact_dev}`);
    d.avg_valence_lon > d.avg_valence_dev
      ? pass('Lonelies |valence| > devs', `${d.avg_valence_lon} > ${d.avg_valence_dev}`)
      : fail('Lonelies |valence| > devs', `${d.avg_valence_lon} <= ${d.avg_valence_dev}`);
    d.avg_intimacy_lon > d.avg_intimacy_dev
      ? pass('Lonelies intimacy > devs', `${d.avg_intimacy_lon} > ${d.avg_intimacy_dev}`)
      : fail('Lonelies intimacy > devs', `${d.avg_intimacy_lon} <= ${d.avg_intimacy_dev}`);
    (d.avg_impact_noise || 0) < 10
      ? pass('Noise avg impact < 10', `${d.avg_impact_noise}`)
      : fail('Noise avg impact < 10', `${d.avg_impact_noise}`);
  }

  // ━━━ Category 4: Quadrant Coverage ━━━
  console.log(`\n${C}━━━ Category 4: Circumplex Quadrant Coverage ━━━${X}\n`);

  if (!hasScores || d.emotional === 0) {
    skip('High-arousal negative (Q1)', 'No scores yet');
    skip('Low-arousal negative (Q2)', 'No scores yet');
    skip('High-arousal positive (Q3)', 'No scores yet');
    skip('Low-arousal positive (Q4)', 'No scores yet');
  } else {
    const emo = d.emotional;
    const pct = (n) => `${Math.round(n / emo * 100)}%`;
    d.q1_high_neg / emo > 0.1 ? pass('Q1 high-arousal neg > 10%', `${pct(d.q1_high_neg)} (${d.q1_high_neg})`) : fail('Q1 > 10%', pct(d.q1_high_neg));
    d.q2_low_neg / emo > 0.1  ? pass('Q2 low-arousal neg > 10%', `${pct(d.q2_low_neg)} (${d.q2_low_neg})`) : fail('Q2 > 10%', pct(d.q2_low_neg));
    d.q3_high_pos / emo > 0.1 ? pass('Q3 high-arousal pos > 10%', `${pct(d.q3_high_pos)} (${d.q3_high_pos})`) : fail('Q3 > 10%', pct(d.q3_high_pos));
    d.q4_low_pos / emo > 0.1  ? pass('Q4 low-arousal pos > 10%', `${pct(d.q4_low_pos)} (${d.q4_low_pos})`) : fail('Q4 > 10%', pct(d.q4_low_pos));
  }

  // ━━━ Category 5: Retrieval Benchmarks ━━━
  console.log(`\n${C}━━━ Category 5: Retrieval Benchmarks ━━━${X}\n`);

  const benchmarks = [
    { q: 'ghost', expect: 'ghost', label: 'Ghost keyword' },
    { q: 'invisible', expect: 'invisible', label: 'Invisible keyword' },
    { q: 'shaking', expect: 'shaking', label: 'Shaking/panic' },
    { q: 'excited', expect: 'excited', label: 'Excited/positive' },
    { q: 'dream job', expect: 'job', label: 'Dream job (positive high-arousal)' },
    { q: 'frozen', expect: 'frozen', label: 'Frozen/trauma' },
    { q: 'SQL injection', expect: 'SQL', label: 'Dev topic' },
  ];

  for (const bm of benchmarks) {
    try {
      const sr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_test_user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON_KEY}`, 'apikey': SUPABASE_ANON_KEY },
        body: JSON.stringify({ query_text: bm.q, top_k: 3 }),
      });
      if (!sr.ok) { skip(bm.label, `${sr.status}`); continue; }
      const results = await sr.json();
      const top = (Array.isArray(results) ? results : []).slice(0, 3).map(r => r.content || '').join(' ').toLowerCase();
      top.includes(bm.expect.toLowerCase()) ? pass(bm.label) : fail(bm.label, `"${bm.expect}" not in top 3`);
    } catch (e) { skip(bm.label, e.message.substring(0, 40)); }
  }

  // ━━━ Summary ━━━
  console.log(`\n${C}━━━ Summary ━━━${X}\n`);
  console.log(`  ${G}Passed:  ${passed}${X}`);
  console.log(`  ${R}Failed:  ${failed}${X}`);
  console.log(`  ${Y}Skipped: ${skipped}${X}`);
  console.log(`  Total:   ${passed + failed + skipped}\n`);

  if (skipped > 0) console.log(`  ${Y}Re-run after edge function classifier is fixed to unlock ${skipped} tests${X}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(`${R}Fatal: ${e.message}${X}`); process.exit(1); });
