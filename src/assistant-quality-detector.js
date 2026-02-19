/**
 * Assistant Quality Detector
 *
 * Detects low-value assistant messages: deflections ("I don't have access to"),
 * echo/clarification paraphrases ("So you want to know about X?"), and
 * non-answers that waste retrieval slots.
 *
 * Two-layer defense:
 * - Layer 1 (capture-time): Tags messages with deflection confidence for storage
 * - Layer 2 (retrieval-time): Same detector penalizes search result scores
 *
 * Version: 1.0.0
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

const DETECTOR_CONFIG = {
  // Length thresholds for severity scoring
  shortMessageLength: 200,
  longMessageLength: 400,

  // Opening window — patterns only in this prefix of long messages
  // get low confidence (hedged-but-substantive)
  openingWindowChars: 150,

  debugMode: false
};

// ============================================================================
// PATTERN DEFINITIONS
// ============================================================================

/**
 * Deflection patterns: assistant admits it cannot help or lacks information.
 * Each regex is case-insensitive and tested against the full message content.
 */
const DEFLECTION_PATTERNS = [
  // Access / capability limitations
  /i don'?t have access to/i,
  /i don'?t have (?:any )?(?:information|data|records?) (?:about|on|regarding)/i,
  /i (?:can'?t|cannot|am unable to) (?:access|retrieve|find|locate|look up)/i,
  /i (?:can'?t|cannot) (?:help|assist) (?:with|you with) that/i,
  /i'?m (?:not able|unable) to (?:access|retrieve|find|provide)/i,

  // Uncertainty / deflection
  /i'?m not sure (?:what|how|if|about) (?:you'?re|that)/i,
  /i don'?t (?:know|recall|remember) (?:what|the|any|about)/i,
  /i don'?t have (?:enough|sufficient) (?:context|information)/i,
  /there'?s no (?:\w+ )?(?:record|information|data|mention|answer|preference) (?:of|about|for|regarding)/i,
  /i (?:couldn'?t|could not) find (?:any|specific|that)/i,

  // Deferral to user
  /could you (?:please )?(?:clarify|elaborate|explain|provide|share|tell me)/i,
  /can you (?:please )?(?:clarify|elaborate|explain|provide|share|tell me)/i,
  /(?:would|could) you (?:mind|like to) (?:providing|sharing|telling)/i,
  /what (?:do you mean|exactly|specifically) (?:by|about|when)/i,
  /i(?:'d| would) need (?:more|additional|further) (?:context|information|details)/i,

  // Explicit inability
  /unfortunately,? i (?:can'?t|cannot|don'?t|am not able)/i,
  /i'?m (?:sorry|afraid),? (?:but )?i (?:don'?t|can'?t|cannot)/i,
  /that(?:'s| is) (?:beyond|outside) (?:my|what i)/i,
  /i (?:have no|lack) (?:way|ability|means) to/i,
  /as an ai,? i (?:don'?t|can'?t|cannot)/i,

  // --- Non-first-person deflections (chat_turns often have impersonal phrasing) ---

  // Impersonal / passive: "no answer was captured", "no preference was found"
  // The inner group `(?:noun (?:or )?)` uses `+` to chain compound nouns
  // ("answer or preference or record"). Keep the noun list under ~8 entries
  // to avoid backtracking risk on long non-matching strings.
  /(?:no|zero) (?:(?:answer|preference|record|information|data) (?:or )?)+(?:was |has been |were )(?:\w+ )?(?:captured|stored|recorded|saved|found)/i,

  // Subject-agnostic "don't have an answer about": catches "Your stored conversations don't have..."
  /(?:don'?t|doesn'?t|do not|does not) have (?:a |an )?(?:direct )?(?:answer|record|information|data|preference) (?:about|for|regarding|on)/i,

  // Empty retrieval: "only contains the question", "retrieved items are just..."
  /only contains? the question/i,
  /(?:retrieved|stored) (?:items?|entries?) (?:are|is|were) (?:just|only)/i,

  // Retrieval-echo: assistant reports stored-data lookup failure
  /stored (?:data|conversations?|items?) (?:still )?(?:don'?t|doesn'?t|do not|does not) have/i,
  /found (?:a |the )?(?:previous |earlier )?conversation.{0,40}?but (?:unfortunately )?(?:no|without|not)/i
];

/**
 * Echo patterns: assistant paraphrases the question back without adding info.
 */
const ECHO_PATTERNS = [
  /(?:so |it (?:sounds|seems) like )you(?:'re| are) (?:asking|looking for|wondering|trying to)/i,
  /(?:so |it (?:sounds|seems) like )you (?:want|need) (?:to know|information|help with)/i,
  /you'?re asking (?:about|whether|if|how)/i,
  /(?:let me (?:understand|make sure)|just to (?:clarify|confirm)):? (?:you|so you|are you)/i,
  /(?:if i understand (?:correctly|you right)),? you/i
];

// ============================================================================
// MAIN DETECTOR
// ============================================================================

/**
 * Detect whether an assistant message is a deflection or echo.
 *
 * @param {string} content - Message text
 * @param {string} role - Message role ('assistant', 'user', etc.)
 * @returns {{ isDeflection: boolean, confidence: number, reason: string|null }}
 */
export function detectDeflection(content, role) {
  // Role gate: only analyze assistant messages
  if (role !== 'assistant') {
    return { isDeflection: false, confidence: 0, reason: null };
  }

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return { isDeflection: false, confidence: 0, reason: null };
  }

  const length = content.length;
  const isShort = length < DETECTOR_CONFIG.shortMessageLength;
  const isLong = length > DETECTOR_CONFIG.longMessageLength;

  // Collect all matches with their position and category
  const matches = [];

  for (const pattern of DEFLECTION_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      matches.push({
        category: 'deflection',
        pattern: pattern.source,
        index: match.index,
        text: match[0]
      });
    }
  }

  for (const pattern of ECHO_PATTERNS) {
    const match = pattern.exec(content);
    if (match) {
      matches.push({
        category: 'echo',
        pattern: pattern.source,
        index: match.index,
        text: match[0]
      });
    }
  }

  // No matches — not a deflection
  if (matches.length === 0) {
    return { isDeflection: false, confidence: 0, reason: null };
  }

  // Determine if all matches are in the opening window of a long message
  const allInOpening = isLong && matches.every(
    m => m.index < DETECTOR_CONFIG.openingWindowChars
  );

  // Severity scoring
  let confidence;
  let reason;

  if (allInOpening) {
    // Long message with patterns only in opening — hedged but substantive
    confidence = 0.30;
    reason = `opening-only hedge (${matches.length} pattern(s) in first ${DETECTOR_CONFIG.openingWindowChars} chars of ${length}-char message)`;
  } else if (isShort) {
    // Short message + any pattern = near-certain garbage
    confidence = 0.95;
    reason = `short deflection (${length} chars, ${matches.length} pattern(s): ${matches[0].category})`;
  } else if (matches.length >= 2) {
    // Multiple patterns in medium message
    confidence = 0.85;
    reason = `multiple patterns (${matches.length}: ${[...new Set(matches.map(m => m.category))].join('+')})`;
  } else {
    // Single pattern in medium message
    confidence = 0.65;
    reason = `single ${matches[0].category} pattern in ${length}-char message`;
  }

  if (DETECTOR_CONFIG.debugMode) {
    console.log(`[DeflectionDetector] confidence=${confidence}, reason=${reason}`);
    matches.forEach(m => {
      console.log(`  [DeflectionDetector] ${m.category} @ char ${m.index}: "${m.text}"`);
    });
  }

  return { isDeflection: true, confidence, reason };
}

/**
 * Apply deflection penalty to a search result's scores.
 *
 * penaltyMultiplier = 1 - (confidence * 0.9)
 *   confidence 0.95 → multiplier 0.145 (86% reduction)
 *   confidence 0.65 → multiplier 0.415 (59% reduction)
 *   confidence 0.30 → multiplier 0.73  (27% reduction)
 *
 * @param {Object} item - Search result with score fields
 * @param {number} confidence - Deflection confidence (0-1)
 * @returns {Object} Item with penalized scores (mutated in place)
 */
export function applyDeflectionPenalty(item, confidence) {
  if (confidence <= 0) return item;

  const multiplier = 1 - (confidence * 0.9);

  // Penalize direct scores (higher = better)
  if (item.cross_encoder_score != null) {
    item.cross_encoder_score *= multiplier;
  }
  if (item.weighted_score != null) {
    item.weighted_score *= multiplier;
  }
  if (item.rrf_score != null) {
    item.rrf_score *= multiplier;
  }

  // Penalize distance (lower = better, inverted)
  if (item.distance != null) {
    // Convert distance→similarity, apply multiplier, convert back
    const similarity = 1 - item.distance;
    item.distance = 1 - (similarity * multiplier);
  }

  return item;
}

// ============================================================================
// CONFIGURATION ACCESS
// ============================================================================

export function getConfig() {
  return { ...DETECTOR_CONFIG };
}

export function updateConfig(updates) {
  Object.assign(DETECTOR_CONFIG, updates);
}

// ============================================================================
// EXPORTS FOR TESTING
// ============================================================================

export const __testing__ = {
  DEFLECTION_PATTERNS,
  ECHO_PATTERNS,
  DETECTOR_CONFIG,
  getConfig,
  updateConfig,
  applyDeflectionPenalty
};
