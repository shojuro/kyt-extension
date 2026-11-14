/**
 * Server-side strip of injected context (supabase/functions/_shared/injected-context.ts).
 *
 * Regression for 2026-11-14: the conversation re-import saved ChatGPT's copy
 * of a question with K.Y.T.'s injected block still attached (6,802 characters,
 * 5 sections). Asked again, that copy scored 0.847 against 0.722 for the real
 * reply and pushed it out of the results.
 */
import { describe, it, expect } from 'vitest';
import {
    stripInjectedContext,
    stripInjectedContextLoose,
    isEchoOfQuery,
} from '../../supabase/functions/_shared/injected-context.ts';
import { cleanResults } from '../../supabase/functions/_shared/result-cleanup.ts';
import { stripInjectionPrefix } from '../../src/context-retrieval.js';

const QUESTION = "Look back on our conversation where we talked about the two projects that I'd like to marry together. You just gave me a list of the reasons why that would be good and bad. Rank that for me.";
const BLOCK = "(For context: I've talked about things like this before in past conversations. Here are some things I've previously shared that might be relevant to what I'm about to say:\n\n" +
    '- "[Outline of the whole message]\n- Brainstorming Ideas (a skill) Into Designs"\n\n' +
    "Here is what an AI assistant told me in those conversations (its words, not mine, and it may have been wrong):\n\n" +
    '- "Let\'s break this down."\n\n' +
    "I'm sharing these so you have the full picture of where I'm coming from.)";

describe('stripInjectedContext', () => {
    it('removes a block appended to the message (ChatGPT)', () => {
        expect(stripInjectedContext(`${QUESTION}\n\n${BLOCK}`)).toBe(QUESTION);
    });

    it('removes a block placed before the message (Claude) and the Gemini wording', () => {
        expect(stripInjectedContext(`${BLOCK}\n\n---\n\nwhat is my test codeword?`)).toBe('what is my test codeword?');
        const gemini = "(For context: I've mentioned some of these topics before. - \"x\" Do not add specific dates unless I ask.) Hello there.";
        expect(stripInjectedContext(gemini)).toBe('Hello there.');
    });

    it('removes the "nothing found" note and leaves ordinary text alone', () => {
        expect(stripInjectedContext('(K.Y.T. memory check: nothing relevant found.)\n\n---\n\nHi')).toBe('Hi');
        expect(stripInjectedContext('For context: I moved to Bangkok (in 2019).')).toBe('For context: I moved to Bangkok (in 2019).');
        expect(stripInjectedContext(null)).toBe('');
    });

    it('agrees with the extension-side strip', () => {
        const stored = `${QUESTION}\n\n${BLOCK}`;
        expect(stripInjectedContext(stored)).toBe(stripInjectionPrefix(stored).content);
    });

    it('strict form keeps a block with no end; loose form cuts it', () => {
        const cut = `${QUESTION}\n\n${BLOCK.slice(0, 200)}`;
        expect(stripInjectedContext(cut)).toBe(cut);
        expect(stripInjectedContextLoose(cut)).toBe(QUESTION);
    });
});

describe('isEchoOfQuery', () => {
    it('recognises an earlier asking of the same question, with or without the block', () => {
        expect(isEchoOfQuery(QUESTION, QUESTION)).toBe(true);
        expect(isEchoOfQuery(`${QUESTION}\n\n${BLOCK.slice(0, 300)}`, QUESTION)).toBe(true);
        expect(isEchoOfQuery(`User: ${QUESTION.toUpperCase()}`, QUESTION)).toBe(true);
    });

    it('keeps text that answers or goes well beyond the question', () => {
        expect(isEchoOfQuery(`${QUESTION} ${'Here is the ranked list with reasons. '.repeat(10)}`, QUESTION)).toBe(false);
        expect(isEchoOfQuery('The two projects are Cleophis and K.Y.T.', QUESTION)).toBe(false);
    });

    it('does not judge short queries', () => {
        expect(isEchoOfQuery('What is K.Y.T.?', 'What is K.Y.T.?')).toBe(false);
    });
});

describe('cleanResults with the query', () => {
    it('drops the echo, strips blocks from the rest, and still works without a query', () => {
        const results = [
            { id: 'echo', content: `${QUESTION}\n\n${BLOCK.slice(0, 300)}` },
            { id: 'mixed', content: `I think marrying the two is necessary.\n\n${BLOCK}` },
            { id: 'plain', content: 'The two projects are Cleophis and K.Y.T.' },
        ];
        const cleaned = cleanResults(results, QUESTION);
        expect(cleaned.map((r) => r.id)).toEqual(['mixed', 'plain']);
        expect(cleaned[0].content).toBe('I think marrying the two is necessary.');
        expect(cleanResults(results).map((r) => r.id)).toEqual(['echo', 'mixed', 'plain']);
    });
});
