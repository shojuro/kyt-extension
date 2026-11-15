/**
 * Poll a platform shortly after the user stops talking to it.
 *
 * ChatGPT turns come from the conversation poller (see local-chunk-policy.js),
 * which ran every 15 minutes. On 2026-11-15 a reply given at 03:55 reached the
 * database at 04:20; a question about it from another assistant at 04:08
 * found nothing. Each captured message now (re)schedules one extra poll a
 * short while later, so a finished exchange is stored within minutes.
 *
 * Pure. Tests: tests/unit/poll-soon.test.js.
 */

/** Minutes of quiet after the last captured message before the extra poll. */
export const POLL_SOON_DELAY_MINUTES = 2;

const SOON_ALARMS = {
  chatgpt: { soon: 'pollChatGPTSoon', regular: 'pollChatGPT' },
};

/**
 * The one-shot alarm to (re)create when a message is captured on a platform,
 * or null when that platform's turns do not come from the poller. Creating an
 * alarm with the same name replaces the pending one, which is the debounce.
 */
export function pollSoonAlarmFor(platform) {
  const entry = SOON_ALARMS[String(platform || '').toLowerCase()];
  return entry ? { name: entry.soon, delayInMinutes: POLL_SOON_DELAY_MINUTES } : null;
}

/** The regular poll alarm a "soon" alarm stands for, or null. */
export function regularAlarmFor(alarmName) {
  const entry = Object.values(SOON_ALARMS).find((e) => e.soon === alarmName);
  return entry ? entry.regular : null;
}
