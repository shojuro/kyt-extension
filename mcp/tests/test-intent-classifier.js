import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyIntent, scoreDirective, scoreMemoryReference, scoreContentDensity } from '../src/lib/intent-classifier.js';

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
