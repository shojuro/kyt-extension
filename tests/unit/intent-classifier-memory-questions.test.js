/**
 * Explicit memory questions must classify as QUERY / explicit_memory_query,
 * without pulling plain statements and ordinary task requests along.
 */

import { describe, it, expect } from 'vitest';
import { classifyIntent } from '../../src/intent-classifier.js';

describe('explicit memory questions → QUERY (explicit_memory_query)', () => {
  it.each([
    'Of the things that we have discussed, what frustrates me the most?',
    'Of the things that we have discussed what is it that frustrates me the most and why?',
    'Out of everything we talked about, which idea was the strongest?',
    'What did we decide about the pricing page?',
    'What have I told you about my sister?',
    'What have we said about the launch date?',
    'Remind me what I said about the Atlas project',
    "Do you remember my dentist's name?",
    'Based on our past conversations, what should I focus on?',
    'According to our previous chats, which option did I prefer?',
    'What are the two projects I said I want to combine, and why?',
    'What was the name of the restaurant I mentioned?',
    'what is my test codeword?',
  ])('%s', (msg) => {
    const r = classifyIntent(msg);
    expect(r.intent).toBe('QUERY');
    expect(r.reason).toBe('explicit_memory_query');
    expect(r.confidenceThreshold).toBe(0.40);
  });
});

describe('statements and task requests keep their classification', () => {
  // Expected values are the classifications from before the memory-question
  // patterns were added (pinned so the new patterns cannot move them).
  it.each([
    ['we discussed this already, just write the function', 'QUERY', 'explicit_memory_query'],
    ["I told my boss I'd finish Friday", 'PASSIVE', 'default_substantive'],
    ['remember to add error handling', 'PASSIVE', 'technical_passive'],
    ['write a poem about memory', 'SKIP', 'no_signal'],
    ['Can you remember to use tabs?', 'SKIP', 'directive'],
    ['What have I done wrong in this function?', 'PASSIVE', 'generic_question'],
    ['What are the two numbers I should add?', 'PASSIVE', 'generic_question'],
    ['Things we have discussed are confidential, write a disclaimer', 'PASSIVE', 'default_substantive'],
    ['Summarize what we have discussed so far', 'SKIP', 'no_signal'],
    ['Tell me about our solar system', 'PASSIVE', 'definition_question'],
    ['In our past, people used horses', 'SKIP', 'no_signal'],
    ['What have you got for me today?', 'PASSIVE', 'generic_question'],
    ['How do I keep state in my session handler?', 'PASSIVE', 'generic_question'],
  ])('%s → %s (%s)', (msg, intent, reason) => {
    const r = classifyIntent(msg);
    expect(r.intent).toBe(intent);
    expect(r.reason).toBe(reason);
  });
});

/**
 * 2026-11-14: "What is K.Y.T.?" was skipped as "low_density" (15 characters),
 * so no search ran at all and the assistant answered from nothing. A short
 * question naming a thing is exactly what a memory system is asked.
 */
describe('short definition questions are searched, not skipped', () => {
  it.each([
    'What is K.Y.T.?',
    'What is cleophis?',
    "what's KYT",
    'Who is Jenn?',
    'Tell me about Cleophis',
  ])('%s', (q) => {
    const r = classifyIntent(q);
    expect(r.intent).toBe('PASSIVE');
    expect(r.reason).toBe('definition_question');
    expect(r.confidenceThreshold).toBeLessThanOrEqual(0.45);
  });

  it('"what do you know about X" is searched one way or another', () => {
    expect(classifyIntent('What do you know about K.Y.T.?').intent).not.toBe('SKIP');
  });

  it('still skips greetings and acknowledgements', () => {
    expect(classifyIntent('thanks, got it!').intent).toBe('SKIP');
    expect(classifyIntent('ok sounds good').intent).toBe('SKIP');
  });
});

describe('questions about what I want or think are memory queries', () => {
  it('the "marry two projects" question', () => {
    const r = classifyIntent('What are the two systems/projects that I want to marry together? and why do I think it will be an advantage to do so?');
    expect(r.intent).toBe('QUERY');
    expect(r.confidenceThreshold).toBeLessThanOrEqual(0.45);
  });

  it('does not treat "can I / should I" how-to questions as memory queries', () => {
    expect(classifyIntent('Can I use a generator function inside this reducer?').intent).not.toBe('QUERY');
  });
});
