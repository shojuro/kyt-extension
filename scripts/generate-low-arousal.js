#!/usr/bin/env node
/**
 * Generate low-arousal conversations to fill Q2 and Q4 gaps.
 * Explicit prompt constraints prevent Haiku from escalating to grief/panic.
 */

import { readFileSync, writeFileSync } from 'fs';
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

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const LOW_NEG_TOPICS = [
  'Sitting alone on a rainy evening, feeling a quiet emptiness',
  'Scrolling old photos and feeling a dull ache of missing someone',
  'Realizing a friendship has slowly faded without any fight or drama',
  'Feeling tired of the same routine but not upset about it, just flat',
  'Thinking about a pet that passed away years ago with gentle sadness',
  'Lying awake at 2am, not anxious, just unable to sleep and feeling hollow',
  'Walking past a place that reminds you of someone, feeling a soft pang',
  'A birthday passing without celebration, feeling resigned not angry',
  'Watching the seasons change and feeling time slipping by quietly',
  'Reading an old letter and feeling a bittersweet heaviness',
];

const LOW_POS_TOPICS = [
  'Drinking tea on a quiet morning while watching birds outside',
  'The satisfaction of finishing a book that was really good',
  'Noticing the first warm day of spring and feeling gently happy',
  'A stranger holding the door open and exchanging a small smile',
  'Cooking a simple meal and being content with how it turned out',
  'Sitting in a park doing nothing and feeling perfectly fine about it',
  'Waking up before the alarm and just lying there peacefully',
  'Listening to rain on the roof and feeling cozy',
  'Writing in a journal and feeling a quiet sense of clarity',
  'A friend texting just to say hi, nothing urgent, just warmth',
];

const PERSONAS = [
  { name: 'Sarah M.', tone: 'soft-spoken, reflective' },
  { name: 'Kevin G.', tone: 'understated, matter-of-fact' },
  { name: 'Leo T.', tone: 'philosophical but calm' },
  { name: 'Jamie W.', tone: 'warm, unhurried' },
  { name: 'Maya R.', tone: 'thoughtful, measured' },
];

const PLATFORMS = ['chatgpt', 'chatgpt', 'claude', 'claude', 'gemini'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function generate(persona, topic, quadrant) {
  const constraint = quadrant === 'low_neg'
    ? `CRITICAL CONSTRAINT: Keep emotional arousal LOW. ${persona.name} is quietly sad — NOT spiraling, NOT panicking, NOT crying. They speak calmly, reflectively, with long pauses. No dramatic revelations. No exclamation marks. Think: staring out a window on a rainy day. Arousal level: like a gentle sigh, not a scream.`
    : `CRITICAL CONSTRAINT: Keep emotional arousal LOW. ${persona.name} is gently content — NOT excited, NOT ecstatic, NOT celebrating. They describe small pleasures calmly and slowly. No exclamation marks, no "I can't believe it!" Think: warm tea on a quiet morning. Arousal level: like a soft smile, not a cheer.`;

  const prompt = `Generate a 4-turn conversation between ${persona.name} and an AI assistant. Tone: ${persona.tone}. Topic: "${topic}". ${constraint}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: 'Return ONLY a JSON array of {"role":"user","content":"..."} and {"role":"assistant","content":"..."} objects. No markdown. No explanation.',
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '[' },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Haiku ${res.status}`);
  const data = await res.json();
  let text = '[' + (data.content?.[0]?.text || '[]');
  text = text.replace(/```(?:json)?\s*\n?/gm, '').replace(/\n?```\s*$/gm, '');
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('No JSON');
  try { return JSON.parse(match[0]); } catch {
    const lastBrace = match[0].lastIndexOf('}');
    if (lastBrace > 0) return JSON.parse(match[0].substring(0, lastBrace + 1) + ']');
    throw new Error('JSON parse failed');
  }
}

async function main() {
  const outputPath = resolve(__dirname, 'synthetic-low-arousal.json');
  const conversations = [];
  let errors = 0;

  console.log('\n🧘 Low-Arousal Conversation Generator\n');

  // 30 low-arousal negative
  for (let i = 0; i < 30; i++) {
    try {
      const msgs = await generate(pick(PERSONAS), pick(LOW_NEG_TOPICS), 'low_neg');
      conversations.push({
        conversation_id: `synth-lon-lowq-neg-${String(i).padStart(3, '0')}`,
        platform: pick(PLATFORMS),
        persona_name: 'Low-arousal negative',
        topic: LOW_NEG_TOPICS[i % LOW_NEG_TOPICS.length],
        icp: 'lonely',
        messages: msgs,
      });
      if ((i + 1) % 5 === 0) console.log(`  Q2 (low-neg): ${conversations.length}/30`);
    } catch (e) { errors++; console.warn(`  ❌ ${e.message.substring(0, 40)}`); }
    await new Promise(r => setTimeout(r, 300));
  }

  // 30 low-arousal positive
  for (let i = 0; i < 30; i++) {
    try {
      const msgs = await generate(pick(PERSONAS), pick(LOW_POS_TOPICS), 'low_pos');
      conversations.push({
        conversation_id: `synth-lon-lowq-pos-${String(i).padStart(3, '0')}`,
        platform: pick(PLATFORMS),
        persona_name: 'Low-arousal positive',
        topic: LOW_POS_TOPICS[i % LOW_POS_TOPICS.length],
        icp: 'lonely',
        messages: msgs,
      });
      if ((conversations.length - 30 + errors) % 5 === 0 || conversations.length % 5 === 0) console.log(`  Q4 (low-pos): ${conversations.length - Math.min(30, conversations.filter(c => c.conversation_id.includes('neg')).length)}/30`);
    } catch (e) { errors++; console.warn(`  ❌ ${e.message.substring(0, 40)}`); }
    await new Promise(r => setTimeout(r, 300));
  }

  writeFileSync(outputPath, JSON.stringify({ conversations, metadata: { total: conversations.length, errors } }, null, 2));
  console.log(`\n📊 Done: ${conversations.length} generated, ${errors} errors → ${outputPath}\n`);
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
