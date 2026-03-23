#!/usr/bin/env node
/**
 * Synthetic Conversation Generator for K.Y.T. Pipeline Testing
 *
 * Generates 1000 diverse conversations across two ICPs (developers + lonelies)
 * using Claude Haiku 4.5, covering all 4 Russell's Circumplex quadrants.
 *
 * Output: scripts/synthetic-conversations.json
 *
 * Usage:
 *   node scripts/generate-synthetic-data.js [--count 1000] [--output path.json]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const TEST_USER_ID = 'b0000002-0000-4000-a000-000000000002';

// ============================================================================
// PERSONAS
// ============================================================================

const DEV_PERSONAS = [
  { id: 'DEV_001', name: 'Marcus Thorne', tone: 'Executive, concise, focused on ROI and strategic risk', focus: 'business strategy' },
  { id: 'DEV_002', name: 'Elena Vance', tone: 'Highly technical, uses DevOps jargon, focused on implementation details', focus: 'CI/CD and infrastructure' },
  { id: 'DEV_003', name: 'Sloane Whitaker', tone: 'Impatient startup founder, fast-paced, wants automation yesterday', focus: 'AI orchestration' },
  { id: 'DEV_004', name: 'David Chen', tone: 'Formal compliance officer, detail-oriented, worried about legalities', focus: 'compliance and security' },
  { id: 'DEV_005', name: 'Jax Miller', tone: 'Blunt senior pentester, hacker-speak, focused on exploit chains', focus: 'vulnerability research' },
];

const LONELY_PERSONAS = [
  { id: 'LON_001', name: 'Sarah M.', tone: 'Vulnerable and reflective, sometimes hopeful', emotionalRange: 'grief, nostalgia, hope, occasional joy' },
  { id: 'LON_002', name: 'Kevin G.', tone: 'Dry humor masking deep pain, self-deprecating', emotionalRange: 'loneliness, self-deprecation, small victories, contentment' },
  { id: 'LON_003', name: 'Maya R.', tone: 'Anxious and fast-talking, spirals easily but rebounds', emotionalRange: 'panic, relief, excitement, dread' },
  { id: 'LON_004', name: 'Leo T.', tone: 'Philosophical and searching, alternates between wonder and anger', emotionalRange: 'existential wonder, anger at injustice, calm acceptance' },
  { id: 'LON_005', name: 'Jamie W.', tone: 'Warm and chatty, shares everything, emotionally expressive', emotionalRange: 'excitement about hobbies, frustration with family, gratitude, jealousy' },
];

// ============================================================================
// TOPIC MAPS — All 4 Russell's Circumplex Quadrants
// ============================================================================

const DEV_TOPICS = [
  'SQL injection vulnerability in a legacy database',
  'API authentication bypass discovered during pentest',
  'CI/CD pipeline security — secrets scanning failing',
  'Setting up a multi-agent AI orchestration workflow',
  'Cloud misconfiguration exposing S3 buckets',
  'Handling sales objections for cybersecurity services',
  'SOC 2 compliance audit preparation',
  'Incident response to suspected ransomware',
  'Identity and access management overhaul',
  'Post-mortem analysis of a production outage',
];

const EMOTIONAL_TOPICS = [
  // High-arousal negative (panic, rage, betrayal)
  'Career panic — might lose job and visa',
  'Furious at a friend who betrayed a deeply personal secret',
  'Public humiliation during a work presentation gone wrong',
  'Financial crisis — behind on rent with no safety net',
  'Discovered partner was lying about something major for months',
  // Low-arousal negative (grief, melancholy, emptiness)
  'Processing the anniversary of a parent passing away',
  'Chronic loneliness — days without speaking to another person',
  'Feeling completely invisible and forgotten by old friends',
  'Burnout so deep that even hobbies feel like chores',
  'Missing home desperately after moving to a new country alone',
  // High-arousal positive (excitement, euphoria, celebration)
  'Just got the dream job offer after months of rejection',
  'Falling in love with someone new and it feels incredible',
  'Creative breakthrough on a personal passion project',
  'First day exploring a new country — everything feels magical',
  'Unexpected reunion with a childhood best friend after 10 years',
  // Low-arousal positive (contentment, gratitude, peace)
  'Quiet Sunday morning with coffee and a really good book',
  'Gratitude for a small unexpected act of kindness from a stranger',
  'Happy nostalgia remembering childhood summers at grandparents house',
  'Peaceful acceptance after finally letting go of an old grudge',
  'Small daily win — finally fixed something that was broken for weeks',
];

const NOISE_TOPICS = [
  'What is the weather like today?',
  'Add milk and eggs to my grocery list',
  'What time is it in Tokyo right now?',
  'Tell me a joke',
  'How do I convert 30 Celsius to Fahrenheit?',
  'What is 15% tip on a $47 bill?',
  'What year did the Berlin Wall fall?',
  'Translate hello into Japanese',
  'How do I reset my wifi router?',
  'What is the capital of Thailand?',
];

const PLATFORMS = ['chatgpt', 'chatgpt', 'chatgpt', 'chatgpt', 'chatgpt',
                   'claude', 'claude', 'claude',
                   'gemini', 'gemini'];

// ============================================================================
// GENERATION via Edge Function (no local API key needed)
// ============================================================================

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function callLLM(prompt) {
  if (ANTHROPIC_KEY) {
    // Direct Anthropic API
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        system: 'You generate realistic conversations. Return ONLY a JSON array of {"role":"user","content":"..."} and {"role":"assistant","content":"..."} objects. No markdown fencing, no explanation. Do not include real PII — use fictional details only.',
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: '[' },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Haiku ${res.status}: ${errText.substring(0, 100)}`);
    }

    const data = await res.json();
    let text = '[' + (data.content?.[0]?.text || '[]');
    // Strip markdown code fencing if present
    text = text.replace(/```(?:json)?\s*\n?/gm, '').replace(/\n?```\s*$/gm, '');
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      // Try to repair truncated JSON — find last complete object
      const arrayStart = text.indexOf('[');
      if (arrayStart >= 0) {
        let repaired = text.substring(arrayStart);
        // Find last complete }, then close the array
        const lastBrace = repaired.lastIndexOf('}');
        if (lastBrace > 0) {
          repaired = repaired.substring(0, lastBrace + 1) + ']';
          try { return JSON.parse(repaired); } catch { /* fall through */ }
        }
      }
      throw new Error('No JSON array in response: ' + text.substring(0, 80));
    }
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // Truncated — find last complete object
      let repaired = jsonMatch[0];
      const lastBrace = repaired.lastIndexOf('}');
      if (lastBrace > 0) {
        repaired = repaired.substring(0, lastBrace + 1) + ']';
        return JSON.parse(repaired);
      }
      throw new Error('JSON parse failed after repair attempt');
    }
  }

  // Fallback: edge function
  const res = await fetch(`${SUPABASE_URL}/functions/v1/llm_completion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      system: 'You generate realistic conversations. Return ONLY a JSON array.',
      user: prompt,
      max_tokens: 1500,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`llm_completion ${res.status}: ${errText.substring(0, 100)}`);
  }

  const data = await res.json();
  const text = data.content || data.text || JSON.stringify(data);
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array in LLM response');
  return JSON.parse(jsonMatch[0]);
}

async function generateConversation(persona, topic, turns, type) {
  let prompt;

  if (type === 'dev') {
    prompt = `Generate a ${turns}-turn conversation between ${persona.name} and an AI assistant. ${persona.name}'s personality: ${persona.tone}. Focus area: ${persona.focus}. Topic: "${topic}". Make it professional and technically specific. Each turn has a user message and an assistant response.`;
  } else if (type === 'emotional') {
    prompt = `Generate a ${turns}-turn conversation between ${persona.name} and an AI assistant (like ChatGPT). ${persona.name}'s personality: ${persona.tone}. Their emotional range includes: ${persona.emotionalRange}. Topic: "${topic}". Make the conversation emotionally authentic and deeply personal — ${persona.name} shares real feelings, specific memories, and vulnerable thoughts. The AI responds with genuine empathy. NOT surface-level — go deep.`;
  } else {
    prompt = `Generate a ${turns}-turn trivial conversation between a user and an AI assistant. Topic: "${topic}". Keep it completely surface-level with zero emotional depth. Short, practical exchanges.`;
  }

  return callLLM(prompt);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const countIdx = args.indexOf('--count');
  const outputIdx = args.indexOf('--output');
  const totalCount = countIdx !== -1 ? parseInt(args[countIdx + 1], 10) : 1000;
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : resolve(__dirname, 'synthetic-conversations.json');

  console.log(`\n🧪 K.Y.T. Synthetic Data Generator`);
  console.log(`   Target: ${totalCount} conversations`);
  console.log(`   Output: ${outputPath}`);
  console.log(`   User:   ${TEST_USER_ID}\n`);

  // Distribution: 45% dev, 45% emotional, 10% noise
  const devCount = Math.round(totalCount * 0.45);
  const emotionalCount = Math.round(totalCount * 0.45);
  const noiseCount = totalCount - devCount - emotionalCount;

  console.log(`   Distribution: ${devCount} dev, ${emotionalCount} emotional, ${noiseCount} noise\n`);

  const conversations = [];
  let errors = 0;

  // Resume from existing file if present
  if (existsSync(outputPath)) {
    try {
      const existing = JSON.parse(readFileSync(outputPath, 'utf-8'));
      if (existing.conversations?.length > 0) {
        conversations.push(...existing.conversations);
        console.log(`📂 Resuming from ${conversations.length} existing conversations\n`);
      }
    } catch { /* start fresh */ }
  }

  const existingDevs = conversations.filter(c => c.icp === 'dev').length;
  const existingEmotional = conversations.filter(c => c.icp === 'lonely').length;
  const existingNoise = conversations.filter(c => c.icp === 'noise').length;

  // Save progress every N conversations
  function saveProgress() {
    writeFileSync(outputPath, JSON.stringify({
      conversations,
      metadata: {
        generated: conversations.length,
        target: totalCount,
        user_id: TEST_USER_ID,
        dev_count: conversations.filter(c => c.icp === 'dev').length,
        emotional_count: conversations.filter(c => c.icp === 'lonely').length,
        noise_count: conversations.filter(c => c.icp === 'noise').length,
        errors,
        generated_at: new Date().toISOString(),
      }
    }, null, 2));
  }

  const PARALLEL = 10; // Concurrent API calls

  // Build job queue: all conversations to generate
  const jobs = [];

  for (let i = existingDevs; i < devCount; i++) {
    const persona = pick(DEV_PERSONAS);
    jobs.push({ idx: i, prefix: 'synth-dev', persona, topic: pick(DEV_TOPICS), platform: pick(PLATFORMS), turns: randInt(3, 7), type: 'dev', icp: 'dev' });
  }
  for (let i = existingEmotional; i < emotionalCount; i++) {
    const persona = pick(LONELY_PERSONAS);
    jobs.push({ idx: i, prefix: 'synth-lon', persona, topic: pick(EMOTIONAL_TOPICS), platform: pick(PLATFORMS), turns: randInt(3, 8), type: 'emotional', icp: 'lonely' });
  }
  for (let i = existingNoise; i < noiseCount; i++) {
    jobs.push({ idx: i, prefix: 'synth-noise', persona: null, topic: pick(NOISE_TOPICS), platform: pick(PLATFORMS), turns: randInt(2, 3), type: 'noise', icp: 'noise' });
  }

  console.log(`   Jobs queued: ${jobs.length} (parallel: ${PARALLEL})\n`);

  // Process in parallel batches
  for (let batch = 0; batch < jobs.length; batch += PARALLEL) {
    const batchJobs = jobs.slice(batch, batch + PARALLEL);

    const results = await Promise.allSettled(
      batchJobs.map(async (job) => {
        const messages = await generateConversation(job.persona, job.topic, job.turns, job.type);
        return {
          conversation_id: `${job.prefix}-${String(job.idx).padStart(4, '0')}`,
          platform: job.platform,
          persona_id: job.persona?.id || 'NOISE',
          persona_name: job.persona?.name || 'General User',
          topic: job.topic,
          icp: job.icp,
          messages,
        };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        conversations.push(r.value);
      } else {
        errors++;
        console.warn(`  ❌ ${r.reason?.message?.substring(0, 80)}`);
      }
    }

    console.log(`  ✅ ${conversations.length}/${totalCount} (batch ${Math.floor(batch / PARALLEL) + 1}/${Math.ceil(jobs.length / PARALLEL)}, errors: ${errors})`);
    saveProgress();

    // Brief delay between parallel batches
    if (batch + PARALLEL < jobs.length) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  saveProgress();

  console.log(`\n📊 Generation complete:`);
  console.log(`   Total: ${conversations.length}`);
  console.log(`   Dev:       ${conversations.filter(c => c.icp === 'dev').length}`);
  console.log(`   Emotional: ${conversations.filter(c => c.icp === 'lonely').length}`);
  console.log(`   Noise:     ${conversations.filter(c => c.icp === 'noise').length}`);
  console.log(`   Errors:    ${errors}`);
  console.log(`   Output:    ${outputPath}\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
