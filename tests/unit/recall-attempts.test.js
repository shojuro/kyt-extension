/**
 * Recall attempts are not memories (supabase/functions/_shared/recall-attempts.ts).
 * Regression for the 2026-11-15 recall set: the Cyrus, Jericho and king cobra
 * questions returned earlier failed attempts to ask the same thing.
 */
import { describe, it, expect } from 'vitest';
import { isRecallQuestion, opensWithDeflection, isRecallAttempt } from '../../supabase/functions/_shared/recall-attempts.ts';

const BLOCK = '``` This block is not supported on your current device yet. ```';

describe('isRecallQuestion', () => {
  it('recognises questions about what was said before', () => {
    for (const q of [
      'what did you tell me about jericho and nar?',
      'what di you teell me about trump? what did we say about cyrus the persian?',
      'You and I were just talking a minute ago about a particular snake that actually is not really a cobra, what was it?',
      'Do you remember the Harvard article we discussed?',
      "we've been talking about a couple of different marsupials that we loosely connected to koalas, do you remember what their names are?",
      'What were the three natural predators that you told me the possum has?',
      'Look back on our conversation. You gave me a list of reasons. Rank that for me?',
    ]) expect(isRecallQuestion(q), q).toBe(true);
  });

  it('leaves ordinary questions and statements alone', () => {
    for (const q of [
      'What is a Pseudochirops archeri?',
      'do they have any natural predators?',
      'I think marrying Cleophis and K.Y.T. together might actually be a really good thing.',
      'Is NAR connected to the Heritage group behind Project 2025?',
      'You told me the build was done. It is not, and here is the log.',
      '',
    ]) expect(isRecallQuestion(q), q).toBe(false);
  });
});

describe('opensWithDeflection', () => {
  it('recognises a reply that starts by saying nothing was found', () => {
    for (const r of [
      `${BLOCK} ${BLOCK} I couldn’t find that conversation either, and I know that’s frustrating. Here’s the gist of the topic.`,
      "I couldn't find the chat where I listed those three predators. I searched your saved chats.",
      'I don’t have enough context to identify which specific snake you’re referring to.',
      'I searched your past chats and couldn’t find where we talked about Jericho and NAR.',
      'This time K.Y.T. brought some of the ChatGPT conversation into this chat. It is only fragments.',
      'Going by the snippets you pasted, there were two.',
    ]) expect(opensWithDeflection(r), r.slice(0, 50)).toBe(true);
  });

  it('keeps replies with real content, and a deflection far from the opening', () => {
    expect(opensWithDeflection('Yes. The Green Ringtail Possum does have natural predators, including pythons and owls.')).toBe(false);
    expect(opensWithDeflection('The two projects are Cleophis and K.Y.T. I found the earlier discussion, including the ranked critique.')).toBe(false);
    // A real ranked answer in the test set opens like this; it must stay.
    expect(opensWithDeflection('The two projects are **Cleophis and K.Y.T. (Keep Your Thoughts)**. Having retrieved the relevant previous discussion, I can establish the distinction.')).toBe(false);
    expect(opensWithDeflection(`${'Jericho fell after seven days of marching. '.repeat(12)} I couldn't find a second source for that.`)).toBe(false);
  });
});

describe('isRecallAttempt', () => {
  it('flags the three shapes seen in the test set', () => {
    expect(isRecallAttempt({ speakers: ['assistant'], content: `${BLOCK} I couldn’t find that conversation either. Here’s the gist: Lance Wallnau calls Trump a Cyrus.` })).toBe(true);
    expect(isRecallAttempt({ speakers: ['user'], content: 'You and I were just talking a minute ago about a particular snake that is not really a cobra, what was it?' })).toBe(true);
    expect(isRecallAttempt({ speakers: ['user'], content: 'User: what did you tell me about jericho and nar? User: what did you tell me about jericho and nar? Assistant: I searched your past chats and could not find it.' })).toBe(true);
  });

  it('keeps answers, statements, long user turns and ordinary chunks', () => {
    expect(isRecallAttempt({ speakers: ['assistant'], content: 'The two projects are Cleophis and K.Y.T. Ranked integration problems: 1. Privacy…' })).toBe(false);
    expect(isRecallAttempt({ speakers: ['user'], content: 'I think marrying Cleophis and K.Y.T. together is necessary.' })).toBe(false);
    expect(isRecallAttempt({ speakers: ['user'], content: `Do you remember the plan? ${'Here is my full reasoning about the launch. '.repeat(30)}` })).toBe(false);
    expect(isRecallAttempt({ speakers: ['user', 'assistant'], content: 'User: What is Isaribi Kochu? Assistant: It is a rare optical phenomenon observed in Japan.' })).toBe(false);
    expect(isRecallAttempt({ speakers: ['assistant'], content: '' })).toBe(false);
    expect(isRecallAttempt({})).toBe(false);
  });
});

describe('an earlier asking of the same recall question', () => {
  const QUERY = 'what did you tell me about trump being referred to as cyrus the persian?';

  it('is caught through typos, as a chunk or a short user turn', async () => {
    const { isRepeatOfRecallQuestion } = await import('../../supabase/functions/_shared/recall-attempts.ts');
    const typo = 'what di you teell me about trump being referred to as cyrus the persian?';
    expect(isRecallQuestion(typo)).toBe(false);
    expect(isRepeatOfRecallQuestion(typo, QUERY)).toBe(true);
    expect(isRecallAttempt({ content: `User: ${typo} Assistant: ${BLOCK} Here is general background on Cyrus.`, speakers: ['user', 'assistant'] }, QUERY)).toBe(true);
    expect(isRecallAttempt({ content: typo, speakers: ['user'] }, QUERY)).toBe(true);
    expect(isRecallAttempt({ content: typo, speakers: ['user'] })).toBe(false);
  });

  it('keeps a real statement that shares the question\'s words', async () => {
    const { isRepeatOfRecallQuestion } = await import('../../supabase/functions/_shared/recall-attempts.ts');
    const q = 'What did I say about running around the Beverly Center and Venice Beach?';
    const statement = 'Oftentimes warm, mainly because we had so many great times running around the city, the Beverly Center, Venice beach, the Four star theater and singing spanish songs with their dad, and what I say about it now is that I was happy.';
    expect(isRepeatOfRecallQuestion(statement, q)).toBe(false);
    expect(isRecallAttempt({ content: statement, speakers: ['user'] }, q)).toBe(false);
    // Not a recall question: nothing is judged.
    expect(isRepeatOfRecallQuestion('How tall is the Eiffel Tower in metres today?', 'How tall is the Eiffel Tower in metres today?')).toBe(false);
  });
});
