/**
 * Poll soon after activity (src/poll-soon.js).
 * Regression for 2026-11-15: a ChatGPT reply reached the database 25 minutes
 * after it was given, after the question about it had already been asked.
 */
import { describe, it, expect } from 'vitest';
import { pollSoonAlarmFor, regularAlarmFor, POLL_SOON_DELAY_MINUTES } from '../../src/poll-soon.js';

describe('poll soon', () => {
  it('schedules one extra ChatGPT poll a couple of minutes after a captured message', () => {
    expect(pollSoonAlarmFor('chatgpt')).toEqual({ name: 'pollChatGPTSoon', delayInMinutes: POLL_SOON_DELAY_MINUTES });
    expect(pollSoonAlarmFor('ChatGPT')).toEqual({ name: 'pollChatGPTSoon', delayInMinutes: POLL_SOON_DELAY_MINUTES });
    expect(POLL_SOON_DELAY_MINUTES).toBeLessThanOrEqual(3);
  });

  it('does nothing for platforms whose turns do not come from the poller', () => {
    expect(pollSoonAlarmFor('claude')).toBeNull();
    expect(pollSoonAlarmFor('gemini')).toBeNull();
    expect(pollSoonAlarmFor(undefined)).toBeNull();
  });

  it('maps the extra alarm back to the regular poll', () => {
    expect(regularAlarmFor('pollChatGPTSoon')).toBe('pollChatGPT');
    expect(regularAlarmFor('pollChatGPT')).toBeNull();
    expect(regularAlarmFor('somethingElse')).toBeNull();
  });
});
