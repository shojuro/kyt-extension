/**
 * Claude send-request reader/editor (platforms/claude/proto-edit.js).
 *
 * Regression for 2026-11-13: claude.ai replaced the JSON `/completion` send
 * with a protobuf `ConversationService/PerformAction` body, so the extension
 * saw no prompt, asked for no memories and injected nothing.
 *
 * The fixtures are built with a tiny encoder below, in the layout recorded
 * from the live site (context = field 1, send action = field 2, prompt = 2.3).
 */
import { describe, it, expect, beforeAll } from 'vitest';

let proto;
beforeAll(async () => {
    await import('../../platforms/claude/proto-edit.js');
    proto = globalThis.KYT_ClaudeProto;
});

// ---- minimal protobuf encoder for fixtures ----
const enc = new TextEncoder();
function varint(n) {
    const out = [];
    while (n > 0x7f) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
    out.push(n);
    return out;
}
const bytesField = (field, payload) => [...varint(field * 8 + 2), ...varint(payload.length), ...payload];
const str = (field, text) => bytesField(field, [...enc.encode(text)]);
const num = (field, value) => [...varint(field * 8), ...varint(value)];

const CONVERSATION = 'eba5a062-4c3f-4690-894a-ec242fb7f308';
const TOOLS = bytesField(8, bytesField(1, [...num(1, 1), ...str(8, 'x'.repeat(300))]));

function sendBody(prompt, { tail = [] } = {}) {
    const context = bytesField(1, [
        ...bytesField(1, [...str(1, 'sess_2abbd65ea2bfd368'), ...num(2, 1)]),
        ...str(2, CONVERSATION),
        ...num(3, 3),
        ...str(14, 'en-US'),
        ...bytesField(15, new Array(32).fill(7)),
    ]);
    const send = bytesField(2, [
        ...str(1, '091b4401-d6c4-418c-9c58-4cc0ad2e1e68'),
        ...str(2, '17dc0a01-cbe3-444f-a916-adb74c722507'),
        ...str(3, prompt),
        ...bytesField(7, str(2, 'claude-fable-5-2')),
        ...TOOLS,
        ...str(12, 'Asia/Bangkok'),
    ]);
    return Uint8Array.from([...context, ...send, ...tail]);
}

/** A non-send action: top-level field 15, no field 2 (recorded 3 s before the send). */
function otherActionBody() {
    return Uint8Array.from([
        ...bytesField(1, [...str(2, CONVERSATION), ...num(3, 3)]),
        ...bytesField(15, bytesField(1, [...bytesField(7, str(2, 'claude-fable-5-2')), ...str(12, 'Asia/Bangkok')])),
    ]);
}

describe('isSendUrl', () => {
    it('matches the new send endpoint, relative or absolute', () => {
        const path = '/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction';
        expect(proto.isSendUrl(path)).toBe(true);
        expect(proto.isSendUrl('https://claude.ai' + path)).toBe(true);
    });

    it('does not match other calls', () => {
        expect(proto.isSendUrl('/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline')).toBe(false);
        expect(proto.isSendUrl('/api/organizations/x/chat_conversations/y/completion')).toBe(false);
        expect(proto.isSendUrl(undefined)).toBe(false);
    });
});

describe('readSend', () => {
    it('reads the prompt, conversation id and model', () => {
        expect(proto.readSend(sendBody('what is my test codeword?'))).toEqual({
            prompt: 'what is my test codeword?',
            conversationId: CONVERSATION,
            model: 'claude-fable-5-2',
        });
    });

    it('accepts an ArrayBuffer body', () => {
        const body = sendBody('hello there');
        expect(proto.readSend(body.buffer.slice(0)).prompt).toBe('hello there');
    });

    it('reads non-ASCII prompts', () => {
        expect(proto.readSend(sendBody('codeword: 鷹-88 ✓')).prompt).toBe('codeword: 鷹-88 ✓');
    });

    it('returns null for an action that carries no prompt', () => {
        expect(proto.readSend(otherActionBody())).toBeNull();
    });

    it('returns null for truncated, empty or non-binary bodies', () => {
        const body = sendBody('what is my test codeword?');
        expect(proto.readSend(body.subarray(0, body.length - 5))).toBeNull();
        expect(proto.readSend(new Uint8Array(0))).toBeNull();
        expect(proto.readSend('{"prompt":"hi"}')).toBeNull();
        expect(proto.readSend(null)).toBeNull();
    });
});

describe('replacePrompt', () => {
    const injected = '[memory] Your test codeword is falcon-88.\n\n---\n\nwhat is my test codeword?';

    it('replaces the prompt and reads back the new one', () => {
        const out = proto.replacePrompt(sendBody('what is my test codeword?'), injected);
        expect(out).toBeInstanceOf(Uint8Array);
        expect(proto.readSend(out)).toEqual({
            prompt: injected,
            conversationId: CONVERSATION,
            model: 'claude-fable-5-2',
        });
    });

    it('changes nothing except the prompt and its length prefixes', () => {
        const original = 'what is my test codeword?';
        const out = proto.replacePrompt(sendBody(original), injected);
        // Swapping the prompt back must give the original bytes exactly.
        const restored = proto.replacePrompt(out, original);
        expect(Array.from(restored)).toEqual(Array.from(sendBody(original)));
    });

    it('keeps bytes that follow the send action', () => {
        const tail = [...str(9, 'trailing-field')];
        const out = proto.replacePrompt(sendBody('hi there', { tail }), 'a much longer prompt '.repeat(20));
        expect(Array.from(out.subarray(out.length - tail.length))).toEqual(tail);
    });

    it('handles a prompt that grows past a one-byte length', () => {
        const big = 'context line. '.repeat(2000); // 28 KB
        const out = proto.replacePrompt(sendBody('short'), big);
        expect(proto.readSend(out).prompt).toBe(big);
    });

    it('does not modify the input buffer', () => {
        const body = sendBody('what is my test codeword?');
        const before = Array.from(body);
        proto.replacePrompt(body, injected);
        expect(Array.from(body)).toEqual(before);
    });

    it('returns null instead of guessing on anything unexpected', () => {
        expect(proto.replacePrompt(otherActionBody(), injected)).toBeNull();
        expect(proto.replacePrompt(sendBody('hi'), '')).toBeNull();
        expect(proto.replacePrompt('{"prompt":"hi"}', injected)).toBeNull();
        const body = sendBody('what is my test codeword?');
        expect(proto.replacePrompt(body.subarray(0, 40), injected)).toBeNull();
    });
});
