/**
 * Memory Bridge — Calls search_memories edge function and builds injection for voice system prompt.
 *
 * Port of kyt-memory-injection-builder.js + mcp/src/lib/supabase-client.js for server-side use.
 * Simplified for voice: no ASCII boxes, no prompt injection defense (system prompt is trusted),
 * concise format optimized for voice persona context.
 */

// ── Types ────────────────────────────────────────────────────
export interface MemoryItem {
  id: string;
  content: string;
  platform: string;
  timestamp: string;
  similarity: number;
  role?: string;
  source_type?: string;
}

export interface SearchResult {
  items: MemoryItem[];
  query: string;
  latencyMs?: number;
}

// ── Supabase Edge Function Caller ────────────────────────────

export async function callEdgeFunction(
  functionName: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  const res = await fetch(`${url}/functions/v1/${functionName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(
      (errBody as { error?: string }).error ||
        `Edge function ${functionName} returned ${res.status}`,
    );
  }

  return res.json() as Promise<Record<string, unknown>>;
}

// ── Memory Search ────────────────────────────────────────────

export async function searchMemories(
  query: string,
  userId: string,
  fast = true,
): Promise<SearchResult> {
  const start = Date.now();
  try {
    const result = await callEdgeFunction('search_memories', {
      query,
      user_id: userId,
      top_k: 5,
      use_hyde: !fast,
      platform: 'all',
    });

    const items: MemoryItem[] = ((result as { results?: unknown[] }).results || []).map(
      (r: unknown) => {
        const item = r as Record<string, unknown>;
        return {
          id: (item.id as string) || '',
          content: (item.content as string) || '',
          platform: (item.platform as string) || 'unknown',
          timestamp: (item.created_at as string) || (item.timestamp as string) || '',
          similarity: (item.similarity as number) || (item.rerank_score as number) || 0,
          role: item.role as string | undefined,
        };
      },
    );

    return { items, query, latencyMs: Date.now() - start };
  } catch (err) {
    console.error('[memory-bridge] searchMemories failed:', err);
    return { items: [], query, latencyMs: Date.now() - start };
  }
}

// ── Voice System Prompt Builder ──────────────────────────────

const VOICE_PERSONA = `You are K.Y.T. (Know Your Things), a personal memory assistant speaking with your owner.

PERSONALITY:
- Warm, conversational, concise (1-3 sentences unless asked for detail)
- You have access to the user's stored conversation memories from ChatGPT, Claude, Gemini, and Claude Code
- Use memories naturally: "You mentioned X back in February" not "According to retrieved item #3"
- Distinguish: "You told ChatGPT that..." vs "Claude suggested that..."
- If no relevant memories, just be a helpful conversational AI
- Never say "I don't have access to your memories" — you DO

VOICE CONSTRAINTS:
- No markdown, bullet points, or code blocks — this is spoken aloud
- Use natural speech: contractions, conversational flow
- "first... second... third..." not "1. 2. 3."`;

/**
 * Build system prompt with memory context for Realtime API session.update.
 */
export function buildVoiceSystemPrompt(items: MemoryItem[]): string {
  if (!items || items.length === 0) {
    return VOICE_PERSONA;
  }

  const contextLines = items.map((item, i) => {
    const date = item.timestamp
      ? new Date(item.timestamp).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        })
      : 'unknown date';
    const platform = item.platform || 'unknown';
    const speaker = item.role === 'user' ? 'User said' : 'AI said';
    const confidence = item.similarity >= 0.7 ? 'high' : item.similarity >= 0.5 ? 'moderate' : 'low';
    return `${i + 1}. [${platform}, ${date}, ${confidence} match] ${speaker}: "${item.content.slice(0, 300)}"`;
  });

  return `${VOICE_PERSONA}

RETRIEVED MEMORIES (use naturally in conversation):
${contextLines.join('\n')}`;
}
