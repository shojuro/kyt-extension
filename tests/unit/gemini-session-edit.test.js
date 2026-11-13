/**
 * Gemini send-request reader/editor (platforms/gemini/session-edit.js).
 *
 * Regression for 2026-11-13: gemini.google.com moved the chat send from the
 * StreamGenerate form to a session channel on another host
 * (geminiweb-pa.clients6.google.com/v1/processSession) with the prompt inside
 * a base64 protobuf form parameter. The extension only looked at
 * gemini.google.com, so it asked for no memories and injected nothing.
 *
 * PROMPT_PARAM and ACK_PARAM below are the exact values recorded from the
 * live site for the message "what is my test codeword?".
 */
import { describe, it, expect, beforeAll } from 'vitest';

let session;
beforeAll(async () => {
    await import('../../platforms/gemini/session-edit.js');
    session = globalThis.KYT_GeminiSession;
});

const PROMPT_PARAM = 'Eh8IAUobChl3aGF0IGlzIG15IHRlc3QgY29kZXdvcmQ/';
const ACK_PARAM = 'IgIIAQ==';
const SETUP_PARAM = Buffer.from(Uint8Array.from([0x0a, 0x06, 0x73, 0x65, 0x74, 0x75, 0x70, 0x21, 0x18, 0x07])).toString('base64');
const form = (...values) =>
    `count=${values.length}&ofs=0&` + values.map((v, i) => `req${i}___data__=${encodeURIComponent(v)}`).join('&');

function decodeParam(body, name) {
    const raw = new URLSearchParams(body).get(name);
    return Buffer.from(raw, 'base64');
}

describe('isSessionUrl', () => {
    it('matches the session endpoint with its query string', () => {
        expect(session.isSessionUrl(
            'https://geminiweb-pa.clients6.google.com/v1/processSession?VER=8&SID=abc&RID=11085&AID=0&t=1'
        )).toBe(true);
    });

    it('does not match other hosts or paths', () => {
        expect(session.isSessionUrl('https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=x')).toBe(false);
        expect(session.isSessionUrl('https://evil.example/v1/processSession')).toBe(false);
        expect(session.isSessionUrl('https://geminiweb-pa.clients6.google.com/v1/other')).toBe(false);
        expect(session.isSessionUrl(undefined)).toBe(false);
    });
});

describe('readSend', () => {
    it('reads the prompt from the recorded single-message body', () => {
        expect(session.readSend(form(PROMPT_PARAM))).toEqual({
            prompt: 'what is my test codeword?',
            param: 'req0___data__',
        });
    });

    it('finds the prompt when a setup message comes first', () => {
        expect(session.readSend(form(SETUP_PARAM, PROMPT_PARAM))).toEqual({
            prompt: 'what is my test codeword?',
            param: 'req1___data__',
        });
    });

    it('returns null for acknowledgements, empty bodies and other forms', () => {
        expect(session.readSend(form(ACK_PARAM))).toBeNull();
        expect(session.readSend('count=0')).toBeNull();
        expect(session.readSend('')).toBeNull();
        expect(session.readSend('f.req=%5Bnull%5D&at=token')).toBeNull();
        expect(session.readSend(null)).toBeNull();
    });

    it('returns null for a corrupted parameter', () => {
        expect(session.readSend(form(PROMPT_PARAM.slice(0, 20)))).toBeNull();
        expect(session.readSend('count=1&ofs=0&req0___data__=%%%')).toBeNull();
    });

    it('refuses to guess when two messages carry a prompt', () => {
        expect(session.readSend(form(PROMPT_PARAM, PROMPT_PARAM))).toBeNull();
    });
});

describe('replacePrompt', () => {
    const injected = 'Context: your test codeword is falcon-88.\n\nwhat is my test codeword?';

    it('replaces the prompt and reads back the new one', () => {
        const out = session.replacePrompt(form(SETUP_PARAM, PROMPT_PARAM), injected);
        expect(session.readSend(out)).toEqual({ prompt: injected, param: 'req1___data__' });
    });

    it('leaves every other form parameter byte-for-byte alone', () => {
        const before = form(SETUP_PARAM, PROMPT_PARAM) + '&extra=a+b%20c';
        const out = session.replacePrompt(before, injected);
        const cut = before.indexOf('req1___data__=');
        expect(out.slice(0, cut)).toBe(before.slice(0, cut));
        expect(out.endsWith('&extra=a+b%20c')).toBe(true);
    });

    it('changes only the prompt inside the message', () => {
        const out = session.replacePrompt(form(PROMPT_PARAM), injected);
        const bytes = decodeParam(out, 'req0___data__');
        const prompt = Buffer.from(injected, 'utf8');
        // 2 { 1: 1, 9 { 1: prompt } } with single-byte lengths (prompt < 120 bytes)
        const expected = Buffer.concat([
            Buffer.from([0x12, prompt.length + 6, 0x08, 0x01, 0x4a, prompt.length + 2, 0x0a, prompt.length]),
            prompt,
        ]);
        expect(bytes.equals(expected)).toBe(true);
    });

    it('swapping the original prompt back restores the recorded body', () => {
        const out = session.replacePrompt(form(PROMPT_PARAM), injected);
        expect(session.replacePrompt(out, 'what is my test codeword?')).toBe(form(PROMPT_PARAM));
    });

    it('handles long and non-ASCII prompts', () => {
        const big = 'контекст 鷹 ✓ '.repeat(1500);
        const out = session.replacePrompt(form(PROMPT_PARAM), big);
        expect(session.readSend(out).prompt).toBe(big);
    });

    it('returns null instead of guessing on anything unexpected', () => {
        expect(session.replacePrompt(form(ACK_PARAM), injected)).toBeNull();
        expect(session.replacePrompt(form(PROMPT_PARAM), '')).toBeNull();
        expect(session.replacePrompt(form(PROMPT_PARAM, PROMPT_PARAM), injected)).toBeNull();
        expect(session.replacePrompt(undefined, injected)).toBeNull();
    });
});
