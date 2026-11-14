/**
 * Which conversation chunks the local sync may store as searchable turns.
 *
 * ChatGPT conversations reach the database twice: from the page as they are
 * typed (every message filed under the conversation "dom_capture", replies cut
 * into fragments, the user's text labelled as the assistant's), and a few
 * minutes later from ChatGPT's own record through the conversation poller
 * (real conversation, whole replies, right speakers). On 2026-11-15 a search
 * from Claude returned fifteen page fragments and none of the clean copy.
 *
 * While the poller is working, it alone supplies ChatGPT turns. If it has not
 * succeeded for a day, the page copy is stored again: poor memory is better
 * than none.
 *
 * Pure functions. Tests: tests/unit/local-chunk-policy.test.js.
 */

export const POLLER_STATE_KEY = 'kyt_poller_state';
/** How recent the poller's last success must be for it to be trusted. */
export const POLLER_TRUST_MS = 24 * 60 * 60 * 1000;
/** Platforms whose turns come from the poller while it is healthy. */
export const REIMPORT_OWNED_PLATFORMS = ['chatgpt'];

/** True when the poller's copy of this platform's conversations is arriving. */
export function reimportOwnsTurns(platform, pollerState, now = Date.now()) {
  if (!REIMPORT_OWNED_PLATFORMS.includes(platform)) return false;
  const lastSuccessAt = pollerState?.[platform]?.lastSuccessAt;
  return typeof lastSuccessAt === 'number' && lastSuccessAt <= now && now - lastSuccessAt < POLLER_TRUST_MS;
}

/** The chunks the local sync should store; the rest are left to the poller. */
export function chunksToStoreLocally(chunks, pollerState, now = Date.now()) {
  return (chunks || []).filter((chunk) => !reimportOwnsTurns(chunk?.platform, pollerState, now));
}
