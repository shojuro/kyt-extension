/**
 * Remembers which conversation chunks were already synced.
 *
 * Each sync re-chunks every conversation the new messages belong to, so a
 * long chat produced the same chunks again on every message. Without this,
 * each of them got five new hypothetical questions (one model call), a new
 * embedding, and a row rewrite that reset entity extraction — measured
 * 2026-11-14: 535 model calls in 30 minutes for one user.
 *
 * Pure functions; the caller owns storage. Tests: tests/unit/chunk-sync-cache.test.js.
 */

export const SYNCED_CHUNKS_KEY = 'kyt_synced_chunks';
export const MAX_REMEMBERED_CHUNKS = 5000;

/** FNV-1a, enough to tell one chunk's text from another's. */
function hashText(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Identity of a chunk and its exact text. A chunk that gains a reply changes. */
export function chunkFingerprint(chunk) {
  const content = typeof chunk?.content === 'string' ? chunk.content : '';
  return [
    chunk?.platform || '',
    chunk?.conversation_id || '',
    chunk?.start_timestamp ?? '',
    content.length,
    hashText(content),
  ].join('|');
}

/** Chunks not yet synced with this exact text. */
export function filterNewChunks(chunks, known) {
  const seen = new Set(Array.isArray(known) ? known : []);
  return (chunks || []).filter((chunk) => !seen.has(chunkFingerprint(chunk)));
}

/** The remembered list with these chunks added, oldest dropped past the cap. */
export function rememberChunks(known, chunks, max = MAX_REMEMBERED_CHUNKS) {
  const added = (chunks || []).map(chunkFingerprint);
  const addedSet = new Set(added);
  const kept = (Array.isArray(known) ? known : []).filter((fp) => !addedSet.has(fp));
  return [...kept, ...addedSet].slice(-max);
}
