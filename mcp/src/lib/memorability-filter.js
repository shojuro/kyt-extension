/**
 * Memorability Filter for Session Ingestion
 *
 * Scores each turn on whether it has lasting value for memory storage.
 * Reuses signal scoring from intent-classifier.js but with different
 * weighting and additional patterns specific to ingestion filtering.
 *
 * Threshold: 0.25 (generous — keep anything with moderate substance)
 */

import {
  scoreContentDensity,
  scorePersonalReference,
  scoreTemporalReference,
  scoreMemoryReference,
} from './intent-classifier.js';

// ── Unmemorable patterns (hard reject) ──────────────────────

const SHORT_DIRECTIVE = /^(?:yes|no|ok|okay|sure|thanks|thank\s*you|correct|exactly|right|continue|proceed|next|good|great|fine|perfect|agreed|noted|understood|got\s*it|sounds?\s*good|let'?s\s*(?:do\s*(?:it|that)|go|proceed|continue))[\s.!?]*$/i;

const ASSISTANT_ACK = /^(?:Done\.?|Ok\.?|Got it\.?|Fixed\.?|Updated\.?|Sure\.?|Understood\.?|Will do\.?|On it\.?|Here you go\.?)$/i;

const LINE_REF_ONLY = /^(?:fix|change|update|modify|edit|look\s+at|check|see)\s+(?:the\s+)?(?:typo|error|bug|issue)?(?:\s+(?:on|at|in))?\s*(?:line\s*)?\d+/i;

const FILE_PATH_ONLY = /^(?:fix|change|update|modify|edit|look\s+at|check|see)\s+(?:the\s+)?(?:file\s+)?[a-zA-Z0-9_\-./]+\.[a-zA-Z]{1,5}(?::\d+)?[\s.!?]*$/i;

// ── Memorable patterns (positive boosters) ──────────────────

const DECISION_PATTERN = /\b(?:decided|decision|chose|approach|architecture|design|because|reason|trade-?off|opted|rationale|instead\s+of)\b/i;

const DEFINITION_PATTERN = /\b(?:defined|definition|means|refers\s+to|concept|principle|rule|policy|standard|convention|pattern)\b/i;

const PERSONAL_CONTEXT = /\b(?:my\s+(?:project|team|company|workflow|setup|environment|stack|preference)|I\s+(?:use|prefer|like|work\s+with|built|chose|decided))\b/i;

// ── Scoring ─────────────────────────────────────────────────

export const MEMORABILITY_THRESHOLD = 0.25;

/**
 * Score a turn's memorability (0.0 - 1.0)
 * @param {{role: string, content: string}} turn
 * @returns {number}
 */
export function scoreMemorability(turn) {
  const content = (turn.content || '').trim();
  const role = turn.role || 'user';

  // Hard reject: too short
  if (content.length < 10) return 0.0;

  // Hard reject: unmemorable patterns
  if (SHORT_DIRECTIVE.test(content)) return 0.0;
  if (role === 'assistant' && ASSISTANT_ACK.test(content)) return 0.0;
  if (LINE_REF_ONLY.test(content)) return 0.05;
  if (FILE_PATH_ONLY.test(content)) return 0.05;

  // Code-only blocks (no explanatory text)
  const withoutCode = content.replace(/```[\s\S]*?```/g, '').trim();
  if (content.includes('```') && withoutCode.length < 20) return 0.05;

  // Score using classifier signals
  const density = scoreContentDensity(content);
  const personal = scorePersonalReference(content.toLowerCase());
  const temporal = scoreTemporalReference(content.toLowerCase());
  const memory = scoreMemoryReference(content.toLowerCase());

  // Memorability boosters
  let bonus = 0;
  if (DECISION_PATTERN.test(content)) bonus += 0.3;
  if (DEFINITION_PATTERN.test(content)) bonus += 0.2;
  if (PERSONAL_CONTEXT.test(content)) bonus += 0.2;

  // Weighted composite
  const score = (
    density * 0.35 +
    personal * 0.20 +
    temporal * 0.15 +
    memory * 0.15 +
    Math.min(bonus, 0.7) * 0.15
  );

  // Assistant responses with substantive length get a floor boost
  if (role === 'assistant' && content.length > 200) {
    return Math.max(score, 0.30);
  }

  return Math.min(score, 1.0);
}

/**
 * Filter turns to only those worth remembering.
 * @param {Array<{role: string, content: string}>} turns
 * @returns {{kept: Array, filtered: number}}
 */
export function filterForMemorability(turns) {
  const kept = [];
  let filtered = 0;

  for (const turn of turns) {
    if (scoreMemorability(turn) >= MEMORABILITY_THRESHOLD) {
      kept.push(turn);
    } else {
      filtered++;
    }
  }

  return { kept, filtered };
}
