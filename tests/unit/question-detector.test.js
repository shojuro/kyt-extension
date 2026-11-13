/**
 * Question detector (supabase/functions/_shared/question-detector.ts and the
 * client copy in src/context-retrieval.js).
 *
 * Turns tagged as questions are stored without an embedding and never
 * retrieved. Regression for 2026-11-13: "my test codeword is falcon-88" was
 * tagged as a question by the short-prompt rule (under 60 chars, no "." or
 * "!"), so the fact was saved but could never be recalled.
 */
import { describe, it, expect } from 'vitest';
import { detectIsQuestionText } from '../../supabase/functions/_shared/question-detector.ts';
import { detectIsQuestion as clientDetect } from '../../src/context-retrieval.js';

const STATEMENTS = [
    'my test codeword is falcon-88',
    'my test codeword is otter-17',
    "my dog's name is Biscuit",
    'I live in Bangkok',
    "I'm allergic to peanuts",
    'we use pnpm for this repo',
    'our launch date is March 3',
];

const QUESTIONS = [
    'what is my test codeword?',
    'my codeword is what?',
    'how do i get a scaleway api key',
    'tell me about ballet',
    'list my projects',
    'continue',
    'next one please',
    'fix the failing test',
];

describe('server question detector', () => {
    it.each(STATEMENTS)('keeps a short first-person fact searchable: %s', (text) => {
        expect(detectIsQuestionText(text)).toBe(false);
    });

    it.each(QUESTIONS)('still tags a question or bare request: %s', (text) => {
        expect(detectIsQuestionText(text)).toBe(true);
    });

    it('does not tag a long statement', () => {
        expect(detectIsQuestionText(
            'The deploy pipeline builds the extension, runs the unit suite and then uploads the zip to the release bucket'
        )).toBe(false);
    });

    it('handles empty input', () => {
        expect(detectIsQuestionText('')).toBe(true);
        expect(detectIsQuestionText(undefined)).toBe(true);
    });
});

describe('client question detector stays in step with the server', () => {
    it.each([...STATEMENTS, ...QUESTIONS])('agrees on: %s', (text) => {
        expect(clientDetect(text, 'user')).toBe(detectIsQuestionText(text));
    });

    it('never tags assistant turns', () => {
        expect(clientDetect('what is my test codeword?', 'assistant')).toBe(false);
    });
});
