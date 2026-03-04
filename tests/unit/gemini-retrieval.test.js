import { describe, it, expect } from 'vitest';
import { ECHO_STOP, echoOverlapRatio, extractPlatformMention } from '../../src/context-retrieval.js';
import { scoreTemporalReference } from '../../src/intent-classifier.js';

/**
 * Tests for Gemini retrieval quality fixes:
 * - Echo filter guard for short content (<3 non-stop words)
 * - Platform-aware rescue regex
 * - MMR boost for gemini source
 */

// Replicate the inline echo filter logic from context-retrieval.js (line 733-744)
// to test the <3 word guard in isolation.
function wouldEchoFilterDrop(query, content) {
  const qWords = new Set(
    query.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/)
      .filter(w => w.length > 2 && !ECHO_STOP.has(w))
  );
  if (qWords.size === 0) return false;

  const normalized = content.toLowerCase().replace(/[^\w\s]/g, '');
  if (normalized.length >= 80) return false; // long content not filtered

  const cWords = new Set(
    normalized.split(/\s+/).filter(w => w.length > 2 && !ECHO_STOP.has(w))
  );
  if (cWords.size < 3) return false; // guard: too few words for reliable detection

  const overlap = [...qWords].filter(w => cWords.has(w)).length;
  return (overlap / Math.max(qWords.size, 1)) > 0.7;
}

describe('Echo filter short-content guard', () => {
  it('should NOT drop very short Gemini content with <3 meaningful words', () => {
    // Typical short Gemini capture: "Walter Payton"
    expect(wouldEchoFilterDrop('Walter Payton', 'Walter Payton')).toBe(false);
  });

  it('should NOT drop 2-word factual content matching query', () => {
    expect(wouldEchoFilterDrop('favorite movie', 'favorite movie')).toBe(false);
  });

  it('should still drop echo with 3+ meaningful words and >70% overlap', () => {
    // "Sound music favorite movie" has 4 non-stop words, all overlap with query
    expect(wouldEchoFilterDrop(
      'sound of music favorite movie',
      'sound music favorite movie'
    )).toBe(true);
  });

  it('should keep content with low overlap even if short', () => {
    expect(wouldEchoFilterDrop(
      'favorite movie',
      'Walter Payton sweetness Chicago Bears'
    )).toBe(false);
  });

  it('should not filter content longer than 80 chars', () => {
    const longContent = 'Walter Payton was an American football running back who played for the Chicago Bears of the NFL for thirteen seasons.';
    expect(wouldEchoFilterDrop('Walter Payton', longContent)).toBe(false);
  });
});

describe('Platform-aware rescue regex', () => {
  // The regex from Fix 3.3
  const platformMentionRe = /\b(gemini|chatgpt|claude|cross.?platform|other\s+(?:chat|conversation|platform))\b/i;

  it('detects "gemini" mention', () => {
    expect(platformMentionRe.test('what did I say in gemini about football')).toBe(true);
  });

  it('detects "chatgpt" mention', () => {
    expect(platformMentionRe.test('recall my ChatGPT conversation about cooking')).toBe(true);
  });

  it('detects "claude" mention', () => {
    expect(platformMentionRe.test('what did I tell Claude about my schedule')).toBe(true);
  });

  it('detects "cross-platform" mention', () => {
    expect(platformMentionRe.test('search cross-platform for my health goals')).toBe(true);
  });

  it('detects "other chat" mention', () => {
    expect(platformMentionRe.test('what did I say in the other chat about this')).toBe(true);
  });

  it('detects "other conversation" mention', () => {
    expect(platformMentionRe.test('find it in my other conversation')).toBe(true);
  });

  it('does NOT match generic queries without platform mention', () => {
    expect(platformMentionRe.test('what is my favorite color')).toBe(false);
  });

  it('does NOT match partial words like "claudette"', () => {
    // \b word boundary should prevent matching "claude" inside "claudette"
    expect(platformMentionRe.test('ask claudette about dinner')).toBe(false);
  });
});

describe('Gemini MMR boost value', () => {
  // Replicate the boost function from context-retrieval.js (line 934-953)
  function computeBoost(item) {
    let boost = 0.0;
    if (item.source === 'cli' || item.source === 'terminal') {
      boost += 0.50;
    }
    if (item.source === 'gemini') {
      boost += 0.10;
    }
    return boost;
  }

  it('gives gemini items +0.10 boost', () => {
    expect(computeBoost({ source: 'gemini' })).toBe(0.10);
  });

  it('gives cli items +0.50 boost (unchanged)', () => {
    expect(computeBoost({ source: 'cli' })).toBe(0.50);
  });

  it('gives chatgpt items no boost', () => {
    expect(computeBoost({ source: 'chatgpt' })).toBe(0.0);
  });

  it('gives claude items no boost', () => {
    expect(computeBoost({ source: 'claude' })).toBe(0.0);
  });
});

describe('extractPlatformMention', () => {
  it('detects gemini', () => {
    expect(extractPlatformMention('what was the last thing I discussed on Gemini?')).toBe('gemini');
  });

  it('detects chatgpt', () => {
    expect(extractPlatformMention('recall my ChatGPT conversation')).toBe('chatgpt');
  });

  it('detects claude', () => {
    expect(extractPlatformMention('what did I tell Claude about my schedule')).toBe('claude');
  });

  it('detects claude-code (hyphenated)', () => {
    expect(extractPlatformMention('my claude-code session')).toBe('claude-code');
  });

  it('detects claude code (space)', () => {
    expect(extractPlatformMention('my Claude Code session')).toBe('claude-code');
  });

  it('returns null for generic queries', () => {
    expect(extractPlatformMention('what is my favorite color')).toBeNull();
  });

  it('returns null for cross-platform mentions without specific platform', () => {
    expect(extractPlatformMention('search all my conversations')).toBeNull();
  });
});

describe('Temporal+platform fallback trigger logic', () => {
  it('scoreTemporalReference scores "last thing" >= 0.4', () => {
    expect(scoreTemporalReference('what was the last thing i discussed on gemini')).toBeGreaterThanOrEqual(0.4);
  });

  it('scoreTemporalReference scores "most recent" >= 0.4', () => {
    expect(scoreTemporalReference('most recent conversation')).toBeGreaterThanOrEqual(0.4);
  });

  it('scoreTemporalReference scores "latest" >= 0.4', () => {
    expect(scoreTemporalReference('latest discussion')).toBeGreaterThanOrEqual(0.4);
  });

  it('scoreTemporalReference scores "recently" >= 0.4', () => {
    expect(scoreTemporalReference('what did i recently discuss')).toBeGreaterThanOrEqual(0.4);
  });

  it('scoreTemporalReference returns 0 for non-temporal query', () => {
    expect(scoreTemporalReference('what is my favorite movie')).toBe(0);
  });

  it('fallback fires when temporal >= 0.4 + platform + no items from platform', () => {
    const msg = 'what was the last thing I discussed on Gemini?';
    const temporal = scoreTemporalReference(msg.toLowerCase());
    const platform = extractPlatformMention(msg);
    const items = [{ source: 'chatgpt' }, { source: 'claude' }]; // no gemini
    const hasTarget = items.some(i => i.source === platform);

    expect(temporal).toBeGreaterThanOrEqual(0.4);
    expect(platform).toBe('gemini');
    expect(hasTarget).toBe(false);
    // All 3 conditions met → fallback would fire
  });

  it('fallback does NOT fire when items from target platform already exist', () => {
    const msg = 'what was the last thing I discussed on Gemini?';
    const platform = extractPlatformMention(msg);
    const items = [{ source: 'gemini' }, { source: 'claude' }]; // has gemini
    const hasTarget = items.some(i => i.source === platform);

    expect(hasTarget).toBe(true);
    // Condition not met → fallback would NOT fire
  });

  it('fallback does NOT fire for non-temporal queries even with platform', () => {
    const msg = 'what did I discuss on Gemini about cooking?';
    const temporal = scoreTemporalReference(msg.toLowerCase());

    expect(temporal).toBe(0); // no temporal signal
    // Condition not met → fallback would NOT fire
  });
});

// Replicate ENTITY_CONCEPT_SYNONYMS from browser-search.js for testing
// (can't import browser-search.js here without Chrome API stubs)
const ENTITY_CONCEPT_SYNONYMS = new Map([
  ['level', ['mode', 'tier']], ['levels', ['modes', 'tiers']],
  ['tier', ['mode', 'level']], ['tiers', ['modes', 'levels']],
  ['nfl', ['football', 'player', 'quarterback']],
  ['football', ['nfl', 'player']],
  ['player', ['athlete']], ['players', ['athletes']],
  ['weight', ['diet', 'fitness', 'kg']],
  ['diet', ['weight', 'nutrition']],
  ['fitness', ['exercise', 'workout']],
  ['goal', ['target', 'objective']], ['goals', ['targets', 'objectives']],
  ['book', ['reading', 'author']], ['books', ['reading', 'authors']],
]);

function expandQuery(query) {
  const words = query.toLowerCase().split(/\s+/);
  const expansions = [];
  for (const word of words) {
    const synonyms = ENTITY_CONCEPT_SYNONYMS.get(word);
    if (synonyms) expansions.push(...synonyms);
  }
  return expansions.length > 0 ? query + ' ' + expansions.join(' ') : query;
}

describe('Entity concept synonym expansion (Gap 2)', () => {
  it('expands "NFL players" with football, player, quarterback, athletes', () => {
    const expanded = expandQuery('NFL players');
    expect(expanded).toContain('football');
    expect(expanded).toContain('quarterback');
    expect(expanded).toContain('athletes');
  });

  it('expands "weight loss goals" with diet, fitness, targets', () => {
    const expanded = expandQuery('weight loss goals');
    expect(expanded).toContain('diet');
    expect(expanded).toContain('fitness');
    expect(expanded).toContain('targets');
  });

  it('expands "3 levels" with mode, tier', () => {
    const expanded = expandQuery('3 levels');
    expect(expanded).toContain('modes');
    expect(expanded).toContain('tiers');
  });

  it('does NOT expand unknown terms', () => {
    const expanded = expandQuery('favorite painting');
    expect(expanded).toBe('favorite painting'); // no expansion
  });

  it('expands "books I read" with reading, authors', () => {
    const expanded = expandQuery('books I read');
    expect(expanded).toContain('reading');
    expect(expanded).toContain('authors');
  });
});
