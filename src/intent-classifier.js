/**
 * Intent Classifier Module
 * Lightweight regex + heuristic classifier that gates memory retrieval.
 * No LLM calls. No API requests. Pure client-side pattern matching.
 *
 * Returns one of three intents:
 *   SKIP    — no injection, pipeline does not fire
 *   QUERY   — full pipeline at default confidence threshold (0.40)
 *   PASSIVE — full pipeline at raised confidence threshold (0.60)
 *
 * IMPORTANT: This gates RETRIEVAL only. Message capture, chunking, sync,
 * entity extraction, preference extraction all continue regardless.
 */

// ── Minimum length for retrieval intent ────────────────────
const MIN_QUERY_LENGTH = 12;

// ── PASSIVE confidence threshold override ──────────────────
export const PASSIVE_CONFIDENCE_THRESHOLD = 0.60;

// ── Optional trailing filler allowed after directive core ──
// Matches: "for me", "for us", "please", "if you can", "would you", "will you"
const TRAILING_FILLER = /(\s+(for\s+(me|us)|please|if\s+you\s+(can|could|would|don't\s+mind)|would\s+you|will\s+you|can\s+you|could\s+you))*/.source;

// ── Category 1a: Directives (instructions TO the AI) ──────
const DIRECTIVE_PATTERNS = [
  // Single-word/short directives
  /^(thoughts|continue|go\s*on|proceed|next|agreed|exactly|correct|yes|no|yep|nope|sure|ok|okay|right|thanks|thank\s*you|perfect|great|good|nice|cool|awesome|interesting|fascinating|hmm+|huh|wow|lol|ha+|true|false|noted|understood|got\s*it|makes\s*sense|fair\s*enough|absolutely|definitely|indeed|precisely)\s*[.!?]*$/i,

  // Action directives (with optional trailing filler like "for me", "please")
  new RegExp(
    '^(break\\s*(this|it)\\s*down|review\\s*(this|it|that)|analyze\\s*(this|it|that)|' +
    'summarize\\s*(this|it|that)|explain\\s*(this|it|that)|elaborate|' +
    'expand\\s*on\\s*(this|that)|rewrite\\s*(this|it|that)|simplify\\s*(this|it|that)|' +
    'translate\\s*(this|it|that)|proofread\\s*(this|it|that)|format\\s*(this|it|that)|' +
    'your\\s*take|what\\s*do\\s*you\\s*think|how\\s*does\\s*that\\s*(sound|look)|' +
    'any\\s*feedback|sounds?\\s*good|looks?\\s*good|that\\s*works?|' +
    "let'?s\\s*(do\\s*(it|that|this)|go|move\\s*on|proceed|continue|start))" +
    TRAILING_FILLER + '\\s*[.!?]*$', 'i'
  ),

  // Continuation signals
  /^(and\??|so\??|also|then\??|plus|more|another|what\s*else|anything\s*else|go\s*ahead|keep\s*going|carry\s*on|moving\s*on|what'?s\s*next)\s*[.!?]*$/i,

  // Emotional/reactive responses (including "Ha! Well played" style compounds)
  /^(haha|lmao|omg|oh\s*wow|oh\s*no|oh\s*man|oh\s*god|damn|dang|yikes|whoa|geez|sheesh|ugh|meh|sigh|nah|naw|ha!?\s*(well\s*played|nice|good(\s*one)?|right|okay|sure|true|fair)?)\s*[.!?]*$/i,

  // Compound directives: "Perfect, let's do it" / "Great, move on" / "Ok, go ahead"
  /^(perfect|great|good|nice|cool|awesome|ok|okay|right|sure|agreed|exactly|sounds?\s*good|looks?\s*good|correct|true|fair\s*enough)[,.]?\s*(let'?s\s*)?(do\s*(it|that|this)|go(\s*ahead)?|move\s*on|proceed|continue|start|go\s*on|keep\s*going|carry\s*on)\s*[.!?]*$/i,
];

// ── Category 1c: Announcements (user telling AI what's coming) ──
const ANNOUNCEMENT_PATTERNS = [
  /^(here'?s|here\s+is|i'?m\s+(going\s+to|gonna|about\s+to)|let\s+me\s+(share|show|paste|give|send)|(i'?ll|i\s+will)\s+(share|show|paste|send|provide|give))\b/i,
  /^(this\s+is\s+(the|a|my)|below\s+is|following\s+is|see\s+below|attached|pasting|copying)\b/i,
  /^(fyi|for\s+(your\s+)?(reference|info|information|context)|just\s+so\s+you\s+know|heads\s+up)\b/i,
];

// ── Category 2: Explicit memory/personal queries ───────────
const EXPLICIT_QUERY_PATTERNS = [
  // Direct memory queries
  /\b(what\s+(is|are|was|were)\s+my)\b/i,
  /\b(what\s+did\s+(I|we)\s+(say|discuss|decide|talk\s+about|agree|mention))\b/i,
  /\b(remind\s+me|do\s+you\s+(remember|recall|know))\b/i,
  /\b(my\s+favorite|my\s+preference|I\s+(like|love|hate|prefer|dislike))\b/i,
  /\b(we\s+(talked|discussed|decided|agreed|mentioned))\b/i,
  /\b(last\s+time\s+(we|I)|previous(ly)?|earlier\s+(we|I|today|this\s+week))\b/i,
  /\b(from\s+(our|my)\s+(conversation|chat|discussion|session))\b/i,
  /\b(what\s+(do\s+you|did\s+you)\s+know\s+about\s+me)\b/i,
  /\b(based\s+on\s+what\s+(you\s+know|we'?ve\s+discussed))\b/i,

  // Decision/conclusion references (past discussion implied)
  /\b(what\s+was\s+(the|our)\s+(final\s+)?(decision|conclusion|verdict|consensus|plan|takeaway|outcome))\b/i,

  // Personal fact queries
  /\b(where\s+do\s+I\s+(live|work|study))\b/i,
  /\b(who\s+(is|are)\s+my\s+)\b/i,
  /\b(what('?s|\s+is)\s+my\s+(name|job|role|car|dog|cat))\b/i,
  /\b(how\s+(old\s+am\s+I|long\s+have\s+I))\b/i,
  /\b(when\s+did\s+(I|we)\s+)\b/i,
];

/**
 * Detect document analysis requests: long pasted content + short directive tail.
 * The pasted content IS the context — memory injection is noise.
 *
 * @param {string} message - Trimmed message text
 * @returns {boolean}
 */
function isDocumentAnalysis(message) {
  const lines = message.trim().split('\n');
  if (lines.length < 5) return false;

  // Check if the LAST non-empty line is a directive tail
  const nonEmptyLines = lines.filter(l => l.trim().length > 0);
  const lastLine = nonEmptyLines[nonEmptyLines.length - 1]?.trim() || '';
  const directiveTail = /^(review|analyze|summarize|thoughts|what\s*do\s*you\s*think|feedback|check\s*this|fix\s*this|improve\s*this|edit\s*this|your\s*take|break\s*(this|it)\s*down|any\s*(thoughts|feedback|issues|concerns|suggestions))\s*[.!?]*$/i;
  if (directiveTail.test(lastLine) && lastLine.length < 200) return true;

  // Code blocks or structured data with substantial length
  const hasCodeBlock = /```[\s\S]{100,}?```/.test(message);
  const hasStructuredData = /^[\s]*[\[{][\s\S]{200,}[\]}]\s*$/m.test(message);
  if ((hasCodeBlock || hasStructuredData) && message.length > 500) return true;

  return false;
}

/**
 * Classifies user message intent for memory retrieval gating.
 * Pure regex + heuristics. No LLM calls. Synchronous. <1ms.
 *
 * @param {string} message - Raw user message text
 * @returns {{ intent: 'SKIP'|'QUERY'|'PASSIVE', reason: string }}
 */
export function classifyIntent(message) {
  if (!message || typeof message !== 'string') {
    return { intent: 'SKIP', reason: 'empty_or_invalid' };
  }

  const trimmed = message.trim();

  // ── SKIP checks ──────────────────────────────────────────

  // 1. Too short to carry retrieval intent
  if (trimmed.length < MIN_QUERY_LENGTH) {
    return { intent: 'SKIP', reason: 'too_short' };
  }

  // 2. Directive pattern match (only on short-ish messages)
  //    Don't classify 500-word messages as directives just because
  //    they start with "review this"
  if (trimmed.length < 200) {
    for (const pattern of DIRECTIVE_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { intent: 'SKIP', reason: 'directive' };
      }
    }
  }

  // 3. Announcement pattern match (check first sentence only)
  //    No total length cap — "Here's the plan..." + 2000 words is still an announcement
  //    Strip leading connectors (then/so/ok/well/now/anyway/alright) before testing
  const firstSentence = trimmed.split(/[.!?\n]/)[0] || '';
  const strippedFirst = firstSentence.replace(/^(then|so|ok|okay|well|now|anyway|alright|also|and|but)\s+/i, '');
  for (const pattern of ANNOUNCEMENT_PATTERNS) {
    if (pattern.test(strippedFirst)) {
      return { intent: 'SKIP', reason: 'announcement' };
    }
  }

  // 4. Document analysis (long content + short directive tail)
  if (isDocumentAnalysis(trimmed)) {
    return { intent: 'SKIP', reason: 'document_analysis' };
  }

  // ── QUERY checks ─────────────────────────────────────────

  for (const pattern of EXPLICIT_QUERY_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { intent: 'QUERY', reason: 'explicit_memory_query' };
    }
  }

  // ── DEFAULT: PASSIVE ─────────────────────────────────────
  return { intent: 'PASSIVE', reason: 'default' };
}
