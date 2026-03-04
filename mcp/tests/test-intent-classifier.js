import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, scoreDirective, scoreMemoryReference, scoreContentDensity, scoreTemporalReference, scoreSynthesisIntent } from '../src/lib/intent-classifier.js';
import { extractPlatformMention } from '../src/lib/platform-utils.js';

describe('intent-classifier (MCP copy)', () => {

  // ── SKIP cases ─────────────────────────────────────────────

  test('SKIP: pure directive "ok"', () => {
    assert.equal(classifyIntent('ok').intent, 'SKIP');
  });

  test('SKIP: pure directive "yes"', () => {
    assert.equal(classifyIntent('yes').intent, 'SKIP');
  });

  test('SKIP: "Thoughts?"', () => {
    assert.equal(classifyIntent('Thoughts?').intent, 'SKIP');
  });

  test('SKIP: "continue"', () => {
    assert.equal(classifyIntent('continue').intent, 'SKIP');
  });

  test('SKIP: compound directive "Perfect, let\'s do it"', () => {
    assert.equal(classifyIntent("Perfect, let's do it").intent, 'SKIP');
  });

  test('SKIP: emotional "haha"', () => {
    assert.equal(classifyIntent('haha').intent, 'SKIP');
  });

  test('SKIP: too short "hi"', () => {
    assert.equal(classifyIntent('hi').intent, 'SKIP');
  });

  test('SKIP: strong directive "fix this"', () => {
    const r = classifyIntent('fix this');
    assert.equal(r.intent, 'SKIP');
  });

  test('SKIP: empty string', () => {
    assert.equal(classifyIntent('').intent, 'SKIP');
  });

  test('SKIP: null input', () => {
    assert.equal(classifyIntent(null).intent, 'SKIP');
  });

  test('SKIP: low density code block', () => {
    const code = '```\nfunction foo() {\n  return bar + baz + qux + quux + corge;\n  const a = 1;\n  const b = 2;\n  if (a > b) console.log("hello world");\n}\n```';
    assert.equal(classifyIntent(code).intent, 'SKIP');
  });

  // ── QUERY cases ────────────────────────────────────────────

  test('QUERY: "What is my favorite painting?"', () => {
    const r = classifyIntent('What is my favorite painting?');
    assert.equal(r.intent, 'QUERY');
    assert.equal(r.confidenceThreshold, 0.40);
    assert.equal(r.reason, 'explicit_memory_query');
  });

  test('QUERY: "What did we discuss about architecture?"', () => {
    const r = classifyIntent('What did we discuss about architecture?');
    assert.equal(r.intent, 'QUERY');
  });

  test('QUERY: "remind me what we decided last week"', () => {
    const r = classifyIntent('remind me what we decided last week');
    assert.equal(r.intent, 'QUERY');
  });

  test('QUERY: personal + temporal "that car I mentioned last week"', () => {
    const r = classifyIntent('that car I mentioned last week was a Jeep');
    assert.equal(r.intent, 'QUERY');
  });

  // ── PASSIVE cases ──────────────────────────────────────────

  test('PASSIVE: generic question "How should I structure the onboarding flow?"', () => {
    const r = classifyIntent('How should I structure the onboarding flow?');
    assert.equal(r.intent, 'PASSIVE');
    assert.equal(r.confidenceThreshold, 0.60);
  });

  // ── Signal scoring functions ───────────────────────────────

  test('scoreDirective: pure directive returns 1.0', () => {
    assert.equal(scoreDirective('ok', 2), 1.0);
    assert.equal(scoreDirective('continue', 8), 1.0);
  });

  test('scoreMemoryReference: "what is my favorite" returns 0.9', () => {
    assert.ok(scoreMemoryReference('what is my favorite car') >= 0.9);
  });

  test('scoreContentDensity: short returns 0', () => {
    assert.equal(scoreContentDensity('hi'), 0.0);
  });

  test('scoreContentDensity: 5-30 word message returns 0.7', () => {
    assert.equal(scoreContentDensity('How should I structure the onboarding flow in my app'), 0.7);
  });

  // ── Consistency with extension copy ────────────────────────

  test('no_signal: short declarative "Python is great"', () => {
    const r = classifyIntent('Python is great');
    assert.equal(r.intent, 'SKIP');
  });
});

// ── extractPlatformMention tests ─────────────────────────────

describe('extractPlatformMention', () => {
  test('extracts "gemini"', () => {
    assert.equal(extractPlatformMention('what did I discuss on Gemini?'), 'gemini');
  });

  test('extracts "chatgpt"', () => {
    assert.equal(extractPlatformMention('my ChatGPT conversations'), 'chatgpt');
  });

  test('extracts "claude-code" (space)', () => {
    assert.equal(extractPlatformMention('in Claude Code session'), 'claude-code');
  });

  test('extracts "claude-code" (hyphen)', () => {
    assert.equal(extractPlatformMention('from claude-code'), 'claude-code');
  });

  test('extracts "claude" (plain)', () => {
    assert.equal(extractPlatformMention('I told Claude about it'), 'claude');
  });

  test('returns null for no platform', () => {
    assert.equal(extractPlatformMention('what is my favorite movie?'), null);
  });

  test('case insensitive', () => {
    assert.equal(extractPlatformMention('on GEMINI yesterday'), 'gemini');
  });
});

// ── Temporal + platform detection combo tests ────────────────

describe('temporal + platform detection', () => {
  test('"what was the last thing I discussed on Gemini?" triggers both', () => {
    const msg = 'what was the last thing I discussed on Gemini?';
    assert.ok(scoreTemporalReference(msg.toLowerCase()) >= 0.4);
    assert.equal(extractPlatformMention(msg), 'gemini');
  });

  test('"what did I discuss on Gemini?" has no temporal signal', () => {
    const msg = 'what did I discuss on Gemini?';
    assert.equal(scoreTemporalReference(msg.toLowerCase()), 0);
  });

  test('"I asked ChatGPT something recently" triggers both', () => {
    const msg = 'I asked ChatGPT something recently';
    assert.ok(scoreTemporalReference(msg.toLowerCase()) >= 0.4);
    assert.equal(extractPlatformMention(msg), 'chatgpt');
  });

  test('"I requested a random list of 10 what?" has no platform', () => {
    const msg = 'I requested a random list of 10 what?';
    assert.equal(extractPlatformMention(msg), null);
  });
});

// ── scoreSynthesisIntent tests ───────────────────────────────

describe('scoreSynthesisIntent', () => {
  test('"connect my goals with reading" >= 0.8', () => {
    assert.ok(scoreSynthesisIntent('connect my weight loss goals with what I was reading') >= 0.8);
  });

  test('"relate fitness to reading" >= 0.8', () => {
    assert.ok(scoreSynthesisIntent('relate my fitness to my reading list') >= 0.8);
  });

  test('"personal goals" >= 0.5', () => {
    assert.ok(scoreSynthesisIntent('tell me about my personal goals') >= 0.5);
  });

  test('"goals and interests" >= 0.7', () => {
    assert.ok(scoreSynthesisIntent('what are my goals and interests') >= 0.7);
  });

  test('non-synthesis returns 0', () => {
    assert.equal(scoreSynthesisIntent('what is my favorite movie'), 0);
  });
});
