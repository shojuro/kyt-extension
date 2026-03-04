// Ported from src/context-retrieval.js extractPlatformMention — keep in sync

/**
 * Extracts a platform mention from user message text.
 * @param {string} message
 * @returns {string|null} Normalized platform name or null
 */
export function extractPlatformMention(message) {
  const m = message.match(/\b(gemini|chatgpt|claude[- ]code|claude)\b/i);
  if (!m) return null;
  return m[1].toLowerCase().replace(/\s+/g, '-');
}
