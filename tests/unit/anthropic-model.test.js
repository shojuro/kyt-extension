/**
 * Anthropic request/response shape for the edge functions
 * (supabase/functions/_shared/anthropic-model.ts).
 *
 * Claude Haiku 5.5 rejects sampling parameters and assistant prefill, thinks by
 * default (so a reply can start with thinking blocks, and thinking shares
 * max_tokens), and has its own prices.
 */
import { describe, it, expect } from 'vitest';
import {
  ANTHROPIC_MODEL,
  buildMessagesBody,
  firstText,
  readJsonReply,
  estimateCostUsd,
  effectiveMaxTokens,
  AnthropicReplyError,
} from '../../supabase/functions/_shared/anthropic-model.ts';

const base = { systemPrompt: 'sys', userPrompt: 'hello', maxTokens: 300 };

describe('model id', () => {
  it('is Claude Haiku 5.5 with no date suffix', () => {
    expect(ANTHROPIC_MODEL).toBe('claude-haiku-5-5');
  });
});

describe('buildMessagesBody (Haiku 5.5)', () => {
  it('sends no sampling parameters even when the caller passes a temperature', () => {
    const body = buildMessagesBody({ ...base, temperature: 0.2 });
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('top_p');
    expect(body).not.toHaveProperty('top_k');
  });

  it('sets effort low and turns thinking off (it tripled the output bill on extraction calls)', () => {
    const body = buildMessagesBody(base);
    expect(body.output_config).toEqual({ effort: 'low' });
    expect(body).not.toHaveProperty('effort');
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('never ends with an assistant prefill, also for JSON requests', () => {
    const body = buildMessagesBody({ ...base, json: true });
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.messages.at(-1).role).toBe('user');
  });

  it('asks for JSON in the system prompt instead of a prefill', () => {
    const plain = buildMessagesBody(base);
    const json = buildMessagesBody({ ...base, json: true });
    expect(plain.system).toBe('sys');
    expect(json.system.startsWith('sys')).toBe(true);
    expect(json.system).toMatch(/single JSON object/i);
  });

  it('keeps the cache breakpoint on the system block', () => {
    const body = buildMessagesBody({ ...base, json: true, enableCache: true });
    expect(body.system).toHaveLength(1);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text).toMatch(/single JSON object/i);
  });

  it('leaves room for thinking in max_tokens', () => {
    expect(effectiveMaxTokens('claude-haiku-5-5', 10)).toBeGreaterThanOrEqual(1024);
    expect(buildMessagesBody({ ...base, maxTokens: 10 }).max_tokens).toBe(effectiveMaxTokens('claude-haiku-5-5', 10));
    expect(effectiveMaxTokens('claude-haiku-5-5', 1200)).toBeGreaterThan(1200 + 1024);
  });
});

describe('buildMessagesBody (Haiku 4.5, kept for rollback)', () => {
  const legacy = { ...base, model: 'claude-haiku-4-5-20251001' };
  it('keeps temperature and the caller max_tokens, and sends no effort', () => {
    const body = buildMessagesBody({ ...legacy, temperature: 0.2 });
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(300);
    expect(body).not.toHaveProperty('output_config');
    expect(body).not.toHaveProperty('thinking');
  });
  it('does not use a prefill either', () => {
    expect(buildMessagesBody({ ...legacy, json: true }).messages).toHaveLength(1);
  });
});

describe('firstText', () => {
  it('skips thinking blocks and returns the first text block', () => {
    const content = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: ' answer ' },
      { type: 'text', text: 'second' },
    ];
    expect(firstText(content)).toBe(' answer ');
  });
  it('returns an empty string when there is no text block', () => {
    expect(firstText([{ type: 'thinking', thinking: '', signature: 's' }])).toBe('');
    expect(firstText(undefined)).toBe('');
    expect(firstText([])).toBe('');
  });
});

describe('readJsonReply', () => {
  const reply = (text, stop_reason = 'end_turn') => ({
    stop_reason,
    content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text }],
  });

  it('parses JSON that follows a thinking block and is followed by prose', () => {
    expect(readJsonReply(reply('{"changed":false}\nNothing to resolve.'))).toEqual({ changed: false });
  });

  it('reports a truncated reply as truncated', () => {
    const err = (() => { try { readJsonReply(reply('{"entities":[{"a"', 'max_tokens')); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(AnthropicReplyError);
    expect(err.kind).toBe('truncated');
  });

  it('reports a refusal without reading content', () => {
    const err = (() => { try { readJsonReply({ stop_reason: 'refusal', content: [] }); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(AnthropicReplyError);
    expect(err.kind).toBe('refusal');
  });

  it('reports thinking-only and prose-only replies', () => {
    const kind = (data) => { try { readJsonReply(data); } catch (e) { return e.kind; } };
    expect(kind({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '', signature: 's' }] })).toBe('truncated');
    expect(kind({ stop_reason: 'end_turn', content: [] })).toBe('empty');
    expect(kind(reply('I could not find anything.'))).toBe('parse');
  });

  it('rejects a top-level array: callers expect an object', () => {
    expect(() => readJsonReply(reply('[1,2,3]'))).toThrow(AnthropicReplyError);
  });
});

describe('estimateCostUsd', () => {
  const M = 1_000_000;
  it('prices Haiku 5.5 at $0.10 in / $0.50 out per million tokens', () => {
    expect(estimateCostUsd('claude-haiku-5-5', { input_tokens: 100_000 })).toBeCloseTo(0.01, 10); // at the 100K limit: still the base card
    expect(estimateCostUsd('claude-haiku-5-5', { input_tokens: 1000, output_tokens: M })).toBeCloseTo(0.5001, 10);
  });
  it('prices Haiku 5.5 cache reads at 0.1x and 5-minute cache writes at 1.25x input', () => {
    expect(estimateCostUsd('claude-haiku-5-5', { cache_read_input_tokens: 50_000 })).toBeCloseTo(0.0005, 10);
    expect(estimateCostUsd('claude-haiku-5-5', { cache_creation_input_tokens: 50_000 })).toBeCloseTo(0.00625, 10);
  });
  it('uses the higher Haiku 5.5 rate card when the prompt is over 100K tokens', () => {
    const usage = { input_tokens: 150_000, output_tokens: 1000 };
    expect(estimateCostUsd('claude-haiku-5-5', usage)).toBeCloseTo(150_000 * 0.5 / M + 1000 * 2.5 / M, 10);
  });
  it('still prices Haiku 4.5 at $1 / $5', () => {
    const usage = { input_tokens: M, output_tokens: M };
    expect(estimateCostUsd('claude-haiku-4-5-20251001', usage)).toBeCloseTo(6, 10);
    expect(estimateCostUsd('claude-haiku-4-5', usage)).toBeCloseTo(6, 10);
  });
  it('throws for a model with no price, rather than logging a made-up cost', () => {
    expect(() => estimateCostUsd('claude-unknown', { input_tokens: 1 })).toThrow(/price/i);
  });
});
