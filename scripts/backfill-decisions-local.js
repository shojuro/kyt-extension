#!/usr/bin/env node
/**
 * Local Decision Backfill — bypasses edge function timeout.
 *
 * Calls Anthropic Haiku directly for entity+decision extraction,
 * then saves results to Supabase via REST. No edge function involved.
 *
 * Usage: node scripts/backfill-decisions-local.js [--batch 20] [--delay 2000] [--max 2000]
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load env from multiple sources
for (const envFile of [resolve(__dirname, '../mcp/.env'), resolve(process.env.HOME || '', '.env')]) {
  try {
    const envContent = readFileSync(envFile, 'utf-8');
    for (const line of envContent.split('\n')) {
      const match = line.match(/^([A-Z_]+)=(.+)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  } catch {}
}

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://svrcvfzlwhnixzuxaccf.supabase.co';
// Service role key bypasses RLS — required for test user b0000002
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TEST_USER_ID = 'b0000002-0000-4000-a000-000000000002';

if (!ANTHROPIC_KEY) { console.error('ANTHROPIC_API_KEY not set'); process.exit(1); }
if (!SUPABASE_KEY) { console.error('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY not set'); process.exit(1); }

// ── Supabase REST helpers ────────────────────────────────────

async function supabaseQuery(table, params = '') {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Query ${table} failed: ${res.status}`);
  return res.json();
}

async function supabaseUpdate(table, id, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', 'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`Update ${table}/${id} failed: ${res.status} ${err.substring(0, 100)}`);
  }
}

async function supabaseInsert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json', 'Prefer': 'return=representation',
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    // 409 = conflict (duplicate) — OK for entities
    if (res.status === 409) return null;
    throw new Error(`Insert ${table} failed: ${res.status} ${err.substring(0, 100)}`);
  }
  const result = await res.json();
  return Array.isArray(result) ? result[0] : result;
}

// ── Haiku extraction ─────────────────────────────────────────

// Minimal extraction prompt — focused on decisions + content_category
const SYSTEM_PROMPT = `Extract structured information from this conversation content. Return ONLY valid JSON:

{
  "content_category": "technical" | "emotional" | "factual" | "mixed",
  "decisions": [
    {
      "decision": "one sentence describing the decision",
      "value": "specific value if applicable",
      "rationale": "why it was decided",
      "alternatives": ["rejected option 1"],
      "constraints": ["constraint that shaped the decision"],
      "context": "domain_topic_in_snake_case"
    }
  ]
}

CONTENT CATEGORY:
- "technical": Code, debugging, architecture, APIs, databases, deployment, frameworks, error messages
- "emotional": Personal feelings, relationships, life events, grief, joy
- "factual": Trivia, general knowledge
- "mixed": Both emotional AND technical

DECISIONS: Only extract when the user committed to a choice. Include value, rationale, alternatives rejected, and constraints. If no decisions, return empty array.

Return ONLY JSON, no markdown.`;

async function extractWithHaiku(content) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: content.substring(0, 4000) }],
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    if (res.status === 429) throw new Error('RATE_LIMITED');
    throw new Error(`Haiku ${res.status}: ${err.substring(0, 100)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '{}';

  try {
    // Strip markdown fencing if present
    const cleaned = text.replace(/```(?:json)?\s*\n?/g, '').replace(/\n?```\s*$/g, '');
    return JSON.parse(cleaned);
  } catch {
    // Try to find JSON object in response
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { content_category: 'emotional', decisions: [] };
  }
}

// ── Main backfill ────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const batchSize = parseInt(args[args.indexOf('--batch') + 1]) || 20;
  const delayMs = parseInt(args[args.indexOf('--delay') + 1]) || 1500;
  const maxRows = parseInt(args[args.indexOf('--max') + 1]) || 2000;

  console.log(`\n🔧 Local Decision Backfill`);
  console.log(`   Batch: ${batchSize} | Delay: ${delayMs}ms | Max: ${maxRows}`);
  console.log(`   User: ${TEST_USER_ID}\n`);

  let totalProcessed = 0;
  let totalDecisions = 0;
  let totalAuditEntries = 0;
  let errors = 0;
  let offset = 0;

  while (totalProcessed < maxRows) {
    // Fetch unprocessed turns
    const rows = await supabaseQuery('chat_turns',
      `user_id=eq.${TEST_USER_ID}&conversation_id=like.tech-%25&entities_extracted=eq.false` +
      `&select=id,content,conversation_id,speakers,created_at` +
      `&order=created_at.asc&limit=${batchSize}`
    );

    if (rows.length === 0) {
      console.log('✅ No more turns to process.');
      break;
    }

    for (const row of rows) {
      try {
        // Skip very short content
        if (!row.content || row.content.trim().length < 15) {
          await supabaseUpdate('chat_turns', row.id, {
            entities_extracted: true, content_category: 'factual',
          });
          totalProcessed++;
          continue;
        }

        // Extract via Haiku
        const result = await extractWithHaiku(row.content);
        const category = ['technical', 'emotional', 'factual', 'mixed'].includes(result.content_category)
          ? result.content_category : 'technical'; // Default technical for tech-* turns
        const decisions = Array.isArray(result.decisions) ? result.decisions : [];

        // Save decisions as entities
        for (const dec of decisions) {
          if (!dec.decision || !dec.context) continue;
          const canonicalName = dec.context.toLowerCase().replace(/[^\w]+/g, '_');
          const metadata = {
            decision: dec.decision,
            value: dec.value || null,
            rationale: dec.rationale || null,
            alternatives: dec.alternatives || [],
            constraints: dec.constraints || [],
            type: 'decision',
          };

          // Check for existing decision to supersede
          const existing = await supabaseQuery('entities',
            `user_id=eq.${TEST_USER_ID}&entity_type=eq.CONCEPT&normalized_name=eq.${canonicalName}` +
            `&superseded_by=is.null&select=id,metadata&limit=1`
          );

          if (existing.length > 0 && existing[0].metadata?.value && dec.value && existing[0].metadata.value !== dec.value) {
            // Supersede
            const newEntity = await supabaseInsert('entities', {
              user_id: TEST_USER_ID,
              entity_text: dec.decision,
              normalized_name: canonicalName,
              entity_type: 'CONCEPT',
              relationship: 'decision',
              context_category: 'technical',
              metadata,
            });
            if (newEntity) {
              await supabaseUpdate('entities', existing[0].id, { superseded_by: newEntity.id });
              await supabaseInsert('memory_audit_log', {
                user_id: TEST_USER_ID,
                action: 'supersede',
                entity_id: existing[0].id,
                old_value: existing[0].metadata.value,
                new_value: dec.value,
                reason: `Value changed: ${existing[0].metadata.value} → ${dec.value}`,
                metadata: { new_entity_id: newEntity.id, context: dec.context },
              });
              totalAuditEntries++;
            }
          } else if (existing.length === 0) {
            // New decision
            const newEntity = await supabaseInsert('entities', {
              user_id: TEST_USER_ID,
              entity_text: dec.decision,
              normalized_name: canonicalName,
              entity_type: 'CONCEPT',
              relationship: 'decision',
              context_category: 'technical',
              metadata,
            });
            if (newEntity) {
              await supabaseInsert('memory_audit_log', {
                user_id: TEST_USER_ID,
                action: 'create_decision',
                entity_id: newEntity.id,
                new_value: dec.value || dec.decision,
                reason: dec.rationale || 'Decision extracted',
                metadata: { context: dec.context },
              });
              totalAuditEntries++;
            }
          }
          totalDecisions++;
        }

        // Mark as processed
        await supabaseUpdate('chat_turns', row.id, {
          entities_extracted: true,
          content_category: category,
        });

        totalProcessed++;

        // Rate limit
        await new Promise(r => setTimeout(r, delayMs));

      } catch (err) {
        if (err.message === 'RATE_LIMITED') {
          console.log('  ⏳ Rate limited, waiting 30s...');
          await new Promise(r => setTimeout(r, 30000));
          continue;
        }
        errors++;
        console.warn(`  ❌ ${row.id}: ${err.message.substring(0, 80)}`);
        // Mark as extracted anyway to avoid infinite retry
        await supabaseUpdate('chat_turns', row.id, {
          entities_extracted: true, content_category: 'technical',
        }).catch(() => {});
        totalProcessed++;
      }
    }

    console.log(`  📊 Progress: ${totalProcessed} processed, ${totalDecisions} decisions, ${totalAuditEntries} audit entries, ${errors} errors`);
  }

  console.log(`\n📊 Backfill complete:`);
  console.log(`   Processed:     ${totalProcessed}`);
  console.log(`   Decisions:     ${totalDecisions}`);
  console.log(`   Audit entries: ${totalAuditEntries}`);
  console.log(`   Errors:        ${errors}\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
