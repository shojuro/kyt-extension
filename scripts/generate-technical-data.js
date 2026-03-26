#!/usr/bin/env node
/**
 * Technical Conversation Generator for K.Y.T. Developer Pipeline Testing
 *
 * Generates realistic developer conversations about codebases — debugging,
 * architecture decisions, code reviews, deployment issues. NOT feelings
 * about code (those are in generate-synthetic-data.js dev personas).
 *
 * Output: scripts/synthetic-technical-conversations.json
 *
 * Usage:
 *   node scripts/generate-technical-data.js [--count 200] [--output path.json]
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
const TEST_USER_ID = 'b0000002-0000-4000-a000-000000000002';

// ============================================================================
// DEV PERSONAS — how they talk about code, not how they feel
// ============================================================================

const TECH_PERSONAS = [
  {
    id: 'TECH_001',
    name: 'Ravi Krishnamurthy',
    tone: 'Senior fullstack dev, precise, uses exact function names and file paths in conversation. Prefers TypeScript.',
    stack: 'React, Next.js, TypeScript, Prisma, PostgreSQL, Vercel',
    project: 'SaaS analytics dashboard called "Metric Flow"',
  },
  {
    id: 'TECH_002',
    name: 'Aisha Okonkwo',
    tone: 'Backend architect, thinks in systems. Discusses trade-offs, scaling, and failure modes. Speaks in architecture patterns.',
    stack: 'Go, gRPC, Kubernetes, Redis, PostgreSQL, Terraform',
    project: 'Payment processing microservice called "PayStream"',
  },
  {
    id: 'TECH_003',
    name: 'Jake Holloway',
    tone: 'Junior dev learning fast, asks lots of "why" questions, shares error messages verbatim. Slightly insecure but eager.',
    stack: 'Python, FastAPI, SQLAlchemy, Docker, GitHub Actions',
    project: 'Internal tool called "TaskTracker" for project management',
  },
  {
    id: 'TECH_004',
    name: 'Mei Lin',
    tone: 'DevOps/SRE specialist, thinks in pipelines and observability. Uses kubectl, helm, and terraform daily. Laconic.',
    stack: 'Kubernetes, Helm, Terraform, Prometheus, Grafana, AWS',
    project: 'Infrastructure for an e-commerce platform called "ShopGrid"',
  },
  {
    id: 'TECH_005',
    name: 'Carlos Mendez',
    tone: 'Mobile dev, switches between iOS and Android. Discusses UI/UX alongside code. Mentions specific Android/iOS APIs.',
    stack: 'Kotlin, Swift, Jetpack Compose, SwiftUI, Firebase, Retrofit',
    project: 'Fitness tracking app called "RepCount"',
  },
];

// ============================================================================
// TECHNICAL TOPIC CATEGORIES
// ============================================================================

const TOPIC_CATEGORIES = {
  debugging: [
    'Auth middleware returning 401 on valid tokens — JWT expiry check is wrong',
    'Database connection pool exhaustion under load — Prisma connection limit',
    'Race condition in payment processing — double charge on retry',
    'Memory leak in React component — useEffect cleanup missing',
    'CORS errors on API calls from mobile app to backend',
    'Flaky CI tests — passes locally, fails in GitHub Actions',
    'N+1 query problem causing 3s page load on dashboard',
    'WebSocket disconnection on mobile when app backgrounds',
    'CSS grid layout breaking on Safari but working in Chrome',
    'Docker container OOM killed — memory limit too low for Node.js',
  ],
  architecture: [
    'Deciding between REST and gRPC for inter-service communication',
    'Monolith to microservices migration strategy — what to split first',
    'Choosing PostgreSQL vs MongoDB for the main data store',
    'Event-driven architecture with Kafka vs simple job queue with BullMQ',
    'API versioning strategy — URL path vs headers vs content negotiation',
    'Caching layer design — Redis vs in-memory vs CDN edge caching',
    'Authentication architecture — JWT vs sessions vs OAuth2 PKCE flow',
    'Database sharding strategy for multi-tenant SaaS',
    'Serverless vs containers for the API layer — cost and latency tradeoffs',
    'Frontend state management — Redux vs Zustand vs React Context',
  ],
  code_review: [
    'Reviewing a PR that adds rate limiting to the API endpoints',
    'Code review feedback on error handling in the payment service',
    'Reviewing database migration that adds indexes to chat_turns table',
    'PR review — refactoring the auth middleware into separate concerns',
    'Code review of WebSocket implementation for real-time notifications',
    'Reviewing test coverage for the user registration flow',
    'PR feedback on TypeScript type definitions for API responses',
    'Code review of Kubernetes deployment manifests — resource limits',
    'Reviewing the new caching layer implementation with Redis',
    'PR review — accessibility improvements in the dashboard components',
  ],
  deployment: [
    'CI/CD pipeline failing on the build step — node_modules cache issue',
    'Blue-green deployment rollback after memory leak in new version',
    'Setting up GitHub Actions for automated testing and deployment',
    'Kubernetes pod CrashLoopBackOff — missing environment variable',
    'Database migration failing in production — column already exists',
    'SSL certificate renewal automation with Let\'s Encrypt',
    'Docker multi-stage build optimization — image size from 2GB to 200MB',
    'Terraform state drift — resources modified manually in AWS console',
    'Setting up Prometheus alerts for API latency > 500ms p99',
    'Canary deployment strategy for the mobile API — 5% traffic split',
  ],
  database: [
    'Designing the schema for a multi-tenant application',
    'Slow query optimization — EXPLAIN ANALYZE shows sequential scan',
    'Database migration strategy for adding a new column to a huge table',
    'Setting up row-level security (RLS) policies in Supabase',
    'Choosing between UUID and auto-increment for primary keys',
    'Full-text search implementation — tsvector vs external search engine',
    'Handling soft deletes vs hard deletes in the user table',
    'Query optimization for the analytics aggregation pipeline',
    'Setting up database replication for read scaling',
    'Data migration from MySQL to PostgreSQL — gotchas and scripts',
  ],
};

const PLATFORMS = ['chatgpt', 'chatgpt', 'chatgpt', 'claude', 'claude', 'claude', 'gemini', 'gemini'];

// ============================================================================
// GENERATION
// ============================================================================

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function callLLM(prompt) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');

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
      system: `You generate realistic developer conversations about code. Return ONLY a JSON array of {"role":"user","content":"..."} and {"role":"assistant","content":"..."} objects. No markdown fencing, no explanation.

CRITICAL RULES:
- The USER must mention SPECIFIC function names, file paths, error messages, package names, and technical terms in their messages
- Include actual code snippets, error messages, and stack traces where natural
- The assistant should reference the same specific technical details in responses
- Use the persona's stack and project context naturally
- Do NOT use real PII — use fictional project/company names
- Conversations should be 4-8 turns (user+assistant pairs)
- The user's messages should contain the kind of information that would be useful to recall later: specific decisions, specific bugs, specific solutions`,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '[' },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Haiku ${res.status}: ${errText.substring(0, 200)}`);
  }

  const data = await res.json();
  let text = '[' + (data.content?.[0]?.text || '[]');
  text = text.replace(/```(?:json)?\s*\n?/gm, '').replace(/\n?```\s*$/gm, '');
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    const arrayStart = text.indexOf('[');
    if (arrayStart >= 0) {
      let repaired = text.substring(arrayStart);
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
    let repaired = jsonMatch[0];
    const lastBrace = repaired.lastIndexOf('}');
    if (lastBrace > 0) {
      repaired = repaired.substring(0, lastBrace + 1) + ']';
      return JSON.parse(repaired);
    }
    throw new Error('JSON parse failed');
  }
}

async function generateConversation(persona, category, topic) {
  const prompt = `Generate a realistic developer conversation about: "${topic}"

PERSONA: ${persona.name} — ${persona.tone}
TECH STACK: ${persona.stack}
PROJECT: ${persona.project}
CATEGORY: ${category}

The user (${persona.name}) is discussing this with an AI assistant. The conversation should:
1. Include SPECIFIC technical details: function names, file paths, error messages, package versions
2. Reference their project "${persona.project}" and stack (${persona.stack}) naturally
3. Contain information that would be useful to recall weeks later
4. Be 4-8 turns (user message + assistant response pairs)
5. The user should share DECISIONS they made and WHY ("We chose X because Y")
6. Include at least one specific error message, function name, or file path

Example of the SPECIFICITY level expected in user messages:
- "The getUserById function in src/services/user-service.ts is throwing a TypeError when the ID is null"
- "We decided to use Redis for the session store instead of PostgreSQL because the read latency was 40ms vs 2ms"
- "The migration 20240315_add_indexes.sql is failing with ERROR: relation 'users_email_idx' already exists"

Generate the conversation now.`;

  const turns = await callLLM(prompt);

  return {
    persona: persona.id,
    personaName: persona.name,
    category,
    topic,
    platform: pick(PLATFORMS),
    stack: persona.stack,
    project: persona.project,
    turns: turns.filter(t => t.role && t.content),
    generated_at: new Date().toISOString(),
  };
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const countIdx = args.indexOf('--count');
  const targetCount = countIdx >= 0 ? parseInt(args[countIdx + 1]) : 200;
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : resolve(__dirname, 'synthetic-technical-conversations.json');

  console.log(`\n🔧 Technical Conversation Generator`);
  console.log(`   Target: ${targetCount} conversations`);
  console.log(`   Personas: ${TECH_PERSONAS.length}`);
  console.log(`   Categories: ${Object.keys(TOPIC_CATEGORIES).length}`);
  console.log(`   Topics: ${Object.values(TOPIC_CATEGORIES).flat().length}`);
  console.log(`   Output: ${outputPath}\n`);

  // Resume from existing output if available
  let conversations = [];
  if (existsSync(outputPath)) {
    try {
      conversations = JSON.parse(readFileSync(outputPath, 'utf-8'));
      console.log(`📂 Resuming from ${conversations.length} existing conversations\n`);
    } catch { /* start fresh */ }
  }

  const allTopics = [];
  for (const [category, topics] of Object.entries(TOPIC_CATEGORIES)) {
    for (const topic of topics) {
      allTopics.push({ category, topic });
    }
  }

  // Generate conversations: each persona × each topic category, distributed evenly
  const BATCH_SIZE = 10;
  let generated = 0;
  let errors = 0;

  while (conversations.length < targetCount) {
    const batch = [];
    for (let i = 0; i < BATCH_SIZE && conversations.length + batch.length + generated < targetCount + errors; i++) {
      const persona = TECH_PERSONAS[conversations.length % TECH_PERSONAS.length];
      const { category, topic } = allTopics[(conversations.length + i) % allTopics.length];
      batch.push(generateConversation(persona, category, topic));
    }

    if (batch.length === 0) break;

    const results = await Promise.allSettled(batch);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        conversations.push(result.value);
        generated++;
        const c = result.value;
        console.log(`  ✅ ${conversations.length}/${targetCount} [${c.category}] ${c.personaName}: "${c.topic.substring(0, 50)}..." (${c.turns.length} turns)`);
      } else {
        errors++;
        console.warn(`  ❌ Error: ${result.reason?.message?.substring(0, 80)}`);
      }
    }

    // Save incrementally
    writeFileSync(outputPath, JSON.stringify(conversations, null, 2));
    console.log(`   💾 Saved ${conversations.length} conversations (${errors} errors)\n`);

    // Rate limit: ~500ms between batches
    await new Promise(r => setTimeout(r, 500));
  }

  // Summary
  const byCategory = {};
  const byPersona = {};
  for (const c of conversations) {
    byCategory[c.category] = (byCategory[c.category] || 0) + 1;
    byPersona[c.personaName] = (byPersona[c.personaName] || 0) + 1;
  }

  console.log(`\n📊 Generation Complete`);
  console.log(`   Total: ${conversations.length} conversations`);
  console.log(`   Errors: ${errors}`);
  console.log(`\n   By Category:`);
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${cat}: ${count}`);
  }
  console.log(`\n   By Persona:`);
  for (const [name, count] of Object.entries(byPersona).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${name}: ${count}`);
  }
  console.log(`\n   Output: ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
