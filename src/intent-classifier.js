/**
 * Intent Classifier v2 — Scored Heuristic System
 *
 * Replaces v1 (pure regex binary matching) with multi-signal scoring.
 * Each message is scored on 6 dimensions; composite score determines
 * classification AND per-message confidence threshold.
 *
 * Returns one of three intents:
 *   SKIP    — no injection, pipeline does not fire
 *   QUERY   — full pipeline at variable threshold (0.40–0.65)
 *   PASSIVE — full pipeline at raised threshold (0.60)
 *
 * IMPORTANT: This gates RETRIEVAL only. Message capture, chunking, sync,
 * entity extraction, preference extraction all continue regardless.
 *
 * Performance: ~60 regex evaluations worst case = ~0.06ms. Pure function.
 */

// ── Minimum length for retrieval intent ────────────────────
const MIN_QUERY_LENGTH = 8;

// ===== SIGNAL SCORING FUNCTIONS =====

// S1: Directive Strength (0.0 – 1.0)
// How much does this message instruct the AI to DO something?

/** @type {RegExp} Pure directives — near-certain when the whole message is just this */
const PURE_DIRECTIVES = /^(thoughts|continue|go\s*on|proceed|next|agreed|exactly|correct|yes|no|yep|nope|sure|ok|okay|right|thanks|thank\s*you|perfect|great|good|nice|cool|awesome|interesting|fascinating|noted|understood|got\s*it|makes\s*sense|fair\s*enough|absolutely|definitely|indeed|precisely|true|false|sounds?\s*good|looks?\s*good|that\s*works?|let'?s\s*(do\s*(it|that|this)|go|move\s*on|proceed|continue|start))\s*[.!?]*$/i;

const DIRECTIVE_STRONG = [
  /^(break|review|analyze|summarize|explain|elaborate|expand|rewrite|simplify|translate|proofread|format|fix|check|evaluate|compare|list|outline)\s*(this|it|that|these|those|them|the\s)/i,
  /^(can\s+you|could\s+you|please|help\s+me|I\s+need\s+you\s+to|go\s+ahead\s+and|let'?s)\s/i,
  /^(what\s+do\s+you\s+think|your\s+(take|thoughts|opinion|assessment)|how\s+does\s+(this|that)\s+(sound|look))\s*\??$/i,
  /^(and\??|so\??|also|then\??|plus|more|another|what\s*else|anything\s*else|go\s*ahead|keep\s*going|carry\s*on|moving\s*on)\s*[.!?]*$/i,
];

const DIRECTIVE_MODERATE = [
  /^(let'?s|I\s+want\s+to|we\s+should|we\s+need\s+to|time\s+to|ready\s+to)\s/i,
  /^(now\s+(let'?s|I('ll|\s+will)|we)|after\s+that|next\s+up|moving\s+on\s+to)/i,
  /^(here'?s|here\s+is|see\s+below|take\s+a\s+look|check\s+this)/i,
  /^(this\s+is\s+(the|a|my)|below\s+is|following\s+is|attached|pasting|copying)\b/i,
  /^(fyi|for\s+(your\s+)?(reference|info|information|context)|just\s+so\s+you\s+know|heads\s+up)\b/i,
  // Announcement of incoming content (user is providing, not requesting)
  /^(then\s+)?I('ll|\s+will)\s+(share|show|paste|send|give|provide|post)\b/i,
  /^(i'?m\s+(going\s+to|gonna|about\s+to)\s+(share|show|paste|send|give|provide))\b/i,
  /^(let\s+me\s+(share|show|paste|send|give|provide))\b/i,
];

/** @type {RegExp} Contextual confirmation/selection patterns */
const CONTEXTUAL_RESPONSE = /^(exactly\s*that|not\s+(quite|exactly|really)|the\s+(first|second|third|last|other)\s+one|option\s+[a-d1-4]|both|neither|all\s+of\s+(them|the\s+above)|that'?s?\s+(it|right|correct)|bingo|nailed\s+it|close\s+enough|not\s+what\s+I\s+meant)/i;

/** @type {RegExp} Emotional/reactive one-liners */
const EMOTIONAL_RESPONSE = /^(haha|lmao|omg|oh\s*wow|oh\s*no|oh\s*man|oh\s*god|damn|dang|yikes|whoa|geez|sheesh|ugh|meh|sigh|nah|naw|lol|ha+|hmm+|huh|wow)\s*[.!?]*$/i;

/** @type {RegExp} Compound directives: "Perfect, let's do it" */
const COMPOUND_DIRECTIVE = /^(perfect|great|good|nice|cool|awesome|ok|okay|right|sure|agreed|exactly|sounds?\s*good|looks?\s*good|correct|true|fair\s*enough)[,.]?\s*(let'?s\s*)?(do\s*(it|that|this)|go(\s*ahead)?|move\s*on|proceed|continue|start|go\s*on|keep\s*going|carry\s*on)\s*[.!?]*$/i;

/**
 * @param {string} message - Trimmed, lowercased message
 * @param {number} len - Message length
 * @returns {number} 0.0–1.0
 */
export function scoreDirective(message, len) {
  const lower = message;
  let score = 0;

  // Pure directives (short messages only)
  if (PURE_DIRECTIVES.test(lower) && len < 80) return 1.0;

  // Emotional/reactive responses
  if (EMOTIONAL_RESPONSE.test(lower)) return 1.0;

  // Compound directives: "Perfect, let's do it"
  if (COMPOUND_DIRECTIVE.test(lower) && len < 120) return 1.0;

  // Contextual confirmation/selection
  if (CONTEXTUAL_RESPONSE.test(lower) && len < 100) {
    score = Math.max(score, 0.9);
  }

  // Strong directive signals
  for (const p of DIRECTIVE_STRONG) {
    if (p.test(lower)) { score = Math.max(score, 0.8); break; }
  }

  // Moderate directive signals
  for (const p of DIRECTIVE_MODERATE) {
    if (p.test(lower)) { score = Math.max(score, 0.7); break; }
  }

  // Weak: imperative verb at start (including continuation verbs)
  if (/^(make|create|build|write|draft|design|generate|produce|continue|proceed|resume)\s/i.test(lower)) {
    score = Math.max(score, 0.4);
  }

  // Short messages with no question mark lean directive
  if (len < 60 && !lower.includes('?') && score > 0) {
    score = Math.min(score + 0.15, 1.0);
  }

  return score;
}


// S2: Memory Reference Strength (0.0 – 1.0)
// How much does this message reference past knowledge or personal data?

const MEMORY_STRONG = [
  /\b(what\s+(is|are|was|were)\s+my)\b/i,
  /\b(what\s+did\s+(I|we)\s+(say|discuss|decide|talk\s+about|agree|mention))\b/i,
  /\b(remind\s+me|do\s+you\s+(remember|recall|know))\b/i,
  /\b(my\s+favorite|my\s+preference|I\s+(like|love|hate|prefer|dislike))\b/i,
  /\b(we\s+(talked|discussed|decided|agreed|mentioned))\b/i,
  /\b(from\s+(our|my)\s+(conversation|chat|discussion|session))\b/i,
  /\b(what\s+(do|did)\s+you\s+know\s+about\s+me)\b/i,
  /\b(based\s+on\s+what\s+(you\s+know|we'?ve\s+discussed))\b/i,
  /\b(where\s+do\s+I\s+(live|work|study))\b/i,
  /\b(what('?s|\s+is)\s+my\s+(name|job|role|car|dog|cat|favorite))\b/i,
  /\b(who\s+(is|are)\s+my\s+)\b/i,
  /\b(what\s+was\s+(the|our)\s+(final\s+)?(decision|conclusion|verdict|consensus|plan|takeaway|outcome))\b/i,
  /\b(how\s+(old\s+am\s+I|long\s+have\s+I))\b/i,
  /\b(when\s+did\s+(I|we)\s+)\b/i,
];

const MEMORY_MODERATE = [
  /\b(earlier|previously|before|last\s+time|the\s+other\s+day)\b/i,
  /\b(we\s+defined|we\s+established|we\s+set\s+up|we\s+designed)\b/i,
  /\b(that\s+(thing|concept|idea|approach|plan)\s+we)\b/i,
  /\b(as\s+(I|we)\s+(said|mentioned|noted|discussed))\b/i,
  /\b(you\s+(said|told|suggested|recommended|mentioned))\b/i,
  /\b(remember\s+(when|that|how))\b/i,
];

/**
 * @param {string} message - Trimmed, lowercased message
 * @returns {number} 0.0–1.0
 */
export function scoreMemoryReference(message) {
  const lower = message;
  let score = 0;

  for (const p of MEMORY_STRONG) {
    if (p.test(lower)) { score = Math.max(score, 0.9); break; }
  }

  for (const p of MEMORY_MODERATE) {
    if (p.test(lower)) { score = Math.max(score, 0.6); break; }
  }

  // Weak: possessives suggesting personal context
  if (/\bmy\s+(project|code|app|site|team|company|plan|strategy|budget)\b/i.test(lower)) {
    score = Math.max(score, 0.35);
  }

  // Weak: definite articles suggesting shared knowledge
  if (/\bthe\s+(bug|issue|plan|strategy|approach|design|architecture)\b/i.test(lower)) {
    score = Math.max(score, 0.2);
  }

  return score;
}


// S3: Content Density (0.0 – 1.0)
// Is there enough substance for a meaningful retrieval query?

/**
 * @param {string} message - Trimmed message (original case)
 * @returns {number} 0.0–1.0
 */
export function scoreContentDensity(message) {
  const trimmed = message;
  const len = trimmed.length;

  if (len < 12) return 0.0;
  if (len < 25) return 0.15;

  // Long multi-line content — likely pasted document
  const lines = trimmed.split('\n');
  if (lines.length > 10) {
    const lastLines = lines.slice(-3).join(' ').trim();
    if (lastLines.length < 200) return 0.1;
  }

  // Code blocks reduce retrieval density
  if (/```[\s\S]{100,}```/.test(trimmed)) return 0.1;

  // Word count sweet spot — checked BEFORE char-length fallback
  // so "How should I structure the onboarding flow?" (45 chars, 8 words)
  // gets 0.7 instead of 0.3
  const words = trimmed.split(/\s+/).length;
  if (words >= 5 && words <= 30) return 0.7;
  if (words > 30 && words <= 60) return 0.5;
  if (words > 60) return 0.3;

  // Short messages with few words (25-49 chars, <5 words)
  if (len < 50) return 0.3;

  return 0.4;
}


// S4: Question Structure (0.0 – 1.0)
// Does this message have question syntax?

/**
 * @param {string} message - Trimmed, lowercased message
 * @returns {number} 0.0–1.0
 */
export function scoreQuestionStructure(message) {
  const lower = message;
  let score = 0;

  if (lower.includes('?')) score = Math.max(score, 0.6);

  if (/^(what|who|where|when|why|how|which|is|are|was|were|did|do|does|can|could|would|will|should|have|has)\s/i.test(lower)) {
    score = Math.max(score, 0.7);
  }

  if (/^(tell\s+me|show\s+me|give\s+me|find\s+me|list|name)\s/i.test(lower)) {
    score = Math.max(score, 0.5);
  }

  return score;
}


// S5: Personal Reference (0.0 – 1.0)
// Does this message reference the user's identity or history?

/**
 * @param {string} message - Trimmed, lowercased message
 * @returns {number} 0.0–1.0
 */
export function scorePersonalReference(message) {
  const lower = message;
  let score = 0;

  const myCount = (lower.match(/\bmy\b/g) || []).length;
  if (myCount >= 2) score = Math.max(score, 0.6);
  else if (myCount === 1) score = Math.max(score, 0.3);

  if (/\bI\s+(said|told|mentioned|wrote|created|built|designed|chose|decided|started|finished|found|saw|bought|learned|tried|picked)\b/i.test(lower)) {
    score = Math.max(score, 0.5);
  }

  // Past continuous: "I was reading/working/thinking/..."
  if (/\bI\s+was\s+\w+ing\b/i.test(lower)) {
    score = Math.max(score, 0.5);
  }

  if (/\bwe\s+(had|made|built|discussed|decided|agreed|defined|established|were)\b/i.test(lower)) {
    score = Math.max(score, 0.5);
  }

  // Demonstrative + personal pronoun: "that book I...", "that thing we..."
  if (/\bthat\s+\w+\s+I\b/i.test(lower)) {
    score = Math.max(score, 0.4);
  }

  return score;
}


// S6: Temporal Reference (0.0 – 1.0)
// Does this message reference a specific time or past event?

/**
 * @param {string} message - Trimmed, lowercased message
 * @returns {number} 0.0–1.0
 */
export function scoreTemporalReference(message) {
  const lower = message;
  let score = 0;

  if (/\b(yesterday|last\s+(week|month|time|session|thing|conversation)|earlier\s+today|this\s+morning|the\s+other\s+day|most\s+recent|latest)\b/i.test(lower)) {
    score = Math.max(score, 0.7);
  }

  if (/\b(earlier|previously|before|ago|back\s+when|at\s+some\s+point|once|recently|recent)\b/i.test(lower)) {
    score = Math.max(score, 0.4);
  }

  if (/\bremember\s+(when|that\s+time)\b/i.test(lower)) {
    score = Math.max(score, 0.8);
  }

  return score;
}


// ===== COMPOSITE CLASSIFICATION =====

/**
 * Internal result constructor.
 * @param {'SKIP'|'QUERY'|'PASSIVE'} intent
 * @param {number|null} confidenceThreshold
 * @param {string} reason
 * @param {Object|null} scores
 */
function result(intent, confidenceThreshold, reason, scores = null) {
  return { intent, confidenceThreshold, reason, scores };
}

/**
 * Classifies user message intent for memory retrieval gating.
 * Uses scored heuristics across 6 signal dimensions.
 *
 * @param {string} message - Raw user message text
 * @returns {{
 *   intent: 'SKIP'|'QUERY'|'PASSIVE',
 *   confidenceThreshold: number|null,
 *   reason: string,
 *   scores: {directive:number, memory:number, density:number,
 *            question:number, personal:number, temporal:number}|null
 * }}
 */
export function classifyIntent(message) {
  if (!message || typeof message !== 'string') {
    return result('SKIP', null, 'empty_or_invalid');
  }

  const trimmed = message.trim();

  // Hard gate: too short to carry retrieval value
  if (trimmed.length < MIN_QUERY_LENGTH) {
    return result('SKIP', null, 'too_short');
  }

  // Score all signals
  const lower = trimmed.toLowerCase();
  const len = trimmed.length;

  const scores = {
    directive:  scoreDirective(lower, len),
    memory:     scoreMemoryReference(lower),
    density:    scoreContentDensity(trimmed),
    question:   scoreQuestionStructure(lower),
    personal:   scorePersonalReference(lower),
    temporal:   scoreTemporalReference(lower),
  };

  // ── Classification logic ─────────────────────────────────

  // SKIP: Strong directive with no memory/personal signal
  if (scores.directive >= 0.7 && scores.memory < 0.3 && scores.personal < 0.3) {
    return result('SKIP', null, 'directive', scores);
  }

  // SKIP: Very low density (pasted code, document analysis) without memory signal
  if (scores.density <= 0.15 && scores.memory < 0.5) {
    return result('SKIP', null, 'low_density', scores);
  }

  // QUERY: Strong explicit memory request
  if (scores.memory >= 0.7) {
    return result('QUERY', 0.40, 'explicit_memory_query', scores);
  }

  // QUERY: Strong personal + temporal reference
  // "that car I mentioned last week"
  if (scores.personal >= 0.4 && scores.temporal >= 0.5) {
    return result('QUERY', 0.45, 'personal_temporal_reference', scores);
  }

  // QUERY: Question structure + personal reference
  // "What did I say about the architecture?"
  if (scores.question >= 0.5 && scores.personal >= 0.4) {
    return result('QUERY', 0.45, 'personal_question', scores);
  }

  // MIXED: Both directive AND memory signals present
  // "Let's spec out the 3 levels we defined earlier"
  if (scores.directive >= 0.4 && scores.memory >= 0.3) {
    return result('QUERY', 0.65, 'mixed_directive_memory', scores);
  }

  // MIXED: Directive + temporal (might reference past work)
  // "Continue where we left off yesterday"
  if (scores.directive >= 0.4 && scores.temporal >= 0.4) {
    return result('QUERY', 0.60, 'mixed_directive_temporal', scores);
  }

  // PASSIVE: Has question structure + sufficient density
  if (scores.question >= 0.5 && scores.density >= 0.4) {
    return result('PASSIVE', 0.60, 'generic_question', scores);
  }

  // PASSIVE: Moderate density WITH sufficient substance to justify pipeline cost
  // Short declarative statements (< 8 words) with density-only signal don't
  // warrant retrieval — "I only read thought books." (5 words, all other signals 0)
  // should not fire the pipeline
  if (scores.density >= 0.4) {
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount >= 8 ||
        scores.question > 0 || scores.memory > 0 ||
        scores.personal >= 0.3 || scores.temporal > 0) {
      return result('PASSIVE', 0.60, 'default_substantive', scores);
    }
  }

  // SKIP: Nothing scored high enough to justify pipeline
  return result('SKIP', null, 'no_signal', scores);
}
