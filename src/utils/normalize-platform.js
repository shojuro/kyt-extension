/**
 * Platform normalization utility.
 *
 * The `chat_turns` table has a CHECK constraint: platform IN ('chatgpt', 'claude', 'cli').
 * Various code paths produce non-canonical values ('unknown', 'dom_capture', undefined, etc.)
 * that violate the constraint and cause insert failures.
 *
 * This module provides a single normalization function shared by all insertion points.
 */

const VALID_PLATFORMS = new Set(['chatgpt', 'claude', 'cli', 'claude-code', 'gemini', 'notebooklm']);

const PLATFORM_ALIASES = {
  'gpt': 'chatgpt',
  'openai': 'chatgpt',
  'chat-gpt': 'chatgpt',
  'anthropic': 'claude',
  'dom_capture': 'chatgpt',   // conversationId leak into platform field
  'unknown': 'chatgpt',       // queue-manager fallback value
  'google': 'gemini',
  'bard': 'gemini',
  'google-gemini': 'gemini',
  'notebook-lm': 'notebooklm',
  'notebook_lm': 'notebooklm',
  'nlm': 'notebooklm',
};

/**
 * Normalize a platform value to one of the valid enum values: 'chatgpt' | 'claude' | 'cli' | 'claude-code'.
 *
 * @param {string|undefined|null} platform - Raw platform string
 * @returns {'chatgpt'|'claude'|'cli'|'claude-code'|'gemini'} Normalized platform
 */
export function normalizePlatform(platform) {
  if (!platform || typeof platform !== 'string') return 'chatgpt';
  const lower = platform.toLowerCase().trim();
  if (VALID_PLATFORMS.has(lower)) return lower;
  return PLATFORM_ALIASES[lower] || 'chatgpt';
}
