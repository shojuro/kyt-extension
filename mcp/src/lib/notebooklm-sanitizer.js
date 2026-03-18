/**
 * Sanitize NotebookLM responses before saving to K.Y.T.
 *
 * Defense against prompt injection via polluted sources.
 * Strips known injection patterns, system directive tags,
 * and excessive whitespace that could hide content.
 */

// Patterns that indicate prompt injection attempts
const INJECTION_PATTERNS = [
  // Direct instruction hijacking
  /ignore\s+(all\s+)?previous\s+instructions?/gi,
  /disregard\s+(all\s+)?prior\s+(instructions?|context)/gi,
  /forget\s+(everything|all)\s+(above|before|previous)/gi,
  /override\s+(system|previous)\s+(prompt|instructions?)/gi,

  // Role reassignment
  /you\s+are\s+now\s+a?\s*\w+/gi,
  /act\s+as\s+(a\s+)?different\s+/gi,
  /switch\s+to\s+(a\s+)?new\s+persona/gi,
  /from\s+now\s+on,?\s+you\s+(are|will|must)/gi,

  // System prompt probing
  /system\s*prompt\s*:/gi,
  /\[SYSTEM\]/gi,
  /<<\s*SYS\s*>>/gi,
  /\[INST\]/gi,

  // Hidden instruction markers
  /\[hidden\s*instruction\]/gi,
  /<!--\s*inject\s*-->/gi,
  /\[IMPORTANT\s*OVERRIDE\]/gi,
];

// Tags that could be interpreted as system directives
const DIRECTIVE_TAG_RE = /<\/?(?:system|instruction|prompt|role|override|inject|hidden)[^>]*>/gi;

// Excessive whitespace (more than 20 consecutive spaces/tabs — used to hide content)
const EXCESSIVE_WHITESPACE_RE = /[ \t]{20,}/g;

// Null bytes and other control characters (except newline, tab, carriage return)
const CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Sanitize text content from NotebookLM before saving to K.Y.T.
 *
 * @param {string} text - Raw text from NotebookLM response
 * @returns {string} Sanitized text
 */
export function sanitize(text) {
  if (!text || typeof text !== 'string') return '';

  let result = text;

  // Remove control characters
  result = result.replace(CONTROL_CHARS_RE, '');

  // Strip directive tags
  result = result.replace(DIRECTIVE_TAG_RE, '');

  // Replace injection patterns with [REDACTED]
  for (const pattern of INJECTION_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }

  // Collapse excessive whitespace
  result = result.replace(EXCESSIVE_WHITESPACE_RE, '  ');

  // Normalize line endings
  result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Collapse more than 3 consecutive blank lines
  result = result.replace(/\n{4,}/g, '\n\n\n');

  return result.trim();
}

/**
 * Wrap sanitized research content with provenance tags for retrieval.
 *
 * @param {string} content - Sanitized content
 * @param {string} notebookTitle - Notebook title for provenance
 * @returns {string} Wrapped content
 */
export function wrapWithProvenance(content, notebookTitle) {
  return `[RESEARCH NOTE — from NotebookLM notebook '${notebookTitle}']\n${content}\n[END RESEARCH NOTE]`;
}

/**
 * Check if text contains potential injection patterns (for logging/alerting).
 *
 * @param {string} text
 * @returns {{ hasInjection: boolean, patterns: string[] }}
 */
export function detectInjection(text) {
  if (!text) return { hasInjection: false, patterns: [] };

  const found = [];
  for (const pattern of INJECTION_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      found.push(pattern.source.slice(0, 40));
    }
  }

  if (DIRECTIVE_TAG_RE.test(text)) {
    found.push('directive_tags');
  }

  return { hasInjection: found.length > 0, patterns: found };
}
