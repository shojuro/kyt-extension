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
    ['Tell me about our solar system', 'PASSIVE', 'generic_question'],
    ['In our past, people used horses', 'SKIP', 'no_signal'],
    ['What have you got for me today?', 'PASSIVE', 'generic_question'],
    ['How do I keep state in my session handler?', 'PASSIVE', 'generic_question'],
  ])('%s → %s (%s)', (msg, intent, reason) => {
    const r = classifyIntent(msg);
    expect(r.intent).toBe(intent);
    expect(r.reason).toBe(reason);
  });
});
