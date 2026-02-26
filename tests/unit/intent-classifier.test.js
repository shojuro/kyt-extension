/**
 * Intent Classifier v2 Tests
 *
 * Tests the scored heuristic intent classification system.
 * Verifies all 12 acceptance criteria from the spec plus
 * signal scoring function behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyIntent,
  scoreDirective,
  scoreMemoryReference,
  scoreContentDensity,
  scoreQuestionStructure,
  scorePersonalReference,
  scoreTemporalReference,
} from '../../src/intent-classifier.js';

// ===== Helper =====
function classify(msg) {
  return classifyIntent(msg);
}

// ==========================================================================
// 1. Acceptance Criteria (spec section 12)
// ==========================================================================
describe('Acceptance Criteria', () => {
  it('AC1: "Thoughts?" → SKIP (directive)', () => {
    const r = classify('Thoughts?');
    expect(r.intent).toBe('SKIP');
    expect(r.scores.directive).toBe(1.0);
  });

  it('AC2: "one-off" → SKIP (too_short)', () => {
    const r = classify('one-off');
    expect(r.intent).toBe('SKIP');
    expect(r.reason).toBe('too_short');
  });

  it('AC3: "Then I will share what the dev\'s plan is from the previous chat." → SKIP (directive)', () => {
    const r = classify("Then I will share what the dev's plan is from the previous chat.");
    expect(r.intent).toBe('SKIP');
    expect(r.scores.directive).toBeGreaterThanOrEqual(0.7);
  });

  it('AC4: "Let\'s spec out the 3 levels we defined earlier." → QUERY threshold 0.65 (mixed)', () => {
    const r = classify("Let's spec out the 3 levels we defined earlier.");
    expect(r.intent).toBe('QUERY');
    expect(r.confidenceThreshold).toBe(0.65);
    expect(r.reason).toBe('mixed_directive_memory');
    expect(r.scores.directive).toBeGreaterThanOrEqual(0.4);
    expect(r.scores.memory).toBeGreaterThanOrEqual(0.3);
  });

  it('AC5: "What is my favorite painting?" → QUERY threshold 0.40 (explicit_memory_query)', () => {
    const r = classify('What is my favorite painting?');
    expect(r.intent).toBe('QUERY');
    expect(r.confidenceThreshold).toBe(0.40);
    expect(r.reason).toBe('explicit_memory_query');
  });

  it('AC6: "Break this down" → SKIP (directive)', () => {
    const r = classify('Break this down');
    expect(r.intent).toBe('SKIP');
    expect(r.reason).toBe('directive');
  });

  it('AC7: Pasted 2000-word document + "Thoughts?" → SKIP', () => {
    const longDoc = 'Lorem ipsum dolor sit amet. '.repeat(200) + '\nThoughts?';
    const r = classify(longDoc);
    expect(r.intent).toBe('SKIP');
  });

  it('AC8: "Do you remember what I said about Lambo doors?" → QUERY threshold 0.40', () => {
    const r = classify('Do you remember what I said about Lambo doors?');
    expect(r.intent).toBe('QUERY');
    expect(r.confidenceThreshold).toBe(0.40);
  });

  it('AC9: "How should I structure the onboarding flow?" → PASSIVE threshold 0.60', () => {
    const r = classify('How should I structure the onboarding flow?');
    expect(r.intent).toBe('PASSIVE');
    expect(r.confidenceThreshold).toBe(0.60);
  });

  it('AC10: All 6 scores present in result', () => {
    const r = classify('What is my favorite painting?');
    expect(r.scores).toBeDefined();
    expect(typeof r.scores.directive).toBe('number');
    expect(typeof r.scores.memory).toBe('number');
    expect(typeof r.scores.density).toBe('number');
    expect(typeof r.scores.question).toBe('number');
    expect(typeof r.scores.personal).toBe('number');
    expect(typeof r.scores.temporal).toBe('number');
  });

  it('AC11: Classification completes in <1ms', () => {
    const messages = [
      'Thoughts?',
      'What is my favorite painting?',
      "Let's spec out the 3 levels we defined earlier.",
      'How should I structure the onboarding flow?',
      'Do you remember what I said about Lambo doors?',
    ];
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      for (const msg of messages) classify(msg);
    }
    const elapsed = performance.now() - start;
    // 500 classifications in under 100ms → each under 0.2ms
    expect(elapsed).toBeLessThan(100);
  });

  it('AC13: Pipeline does NOT fire for SKIP-classified messages', () => {
    const skipMessages = [
      'Thoughts?', 'ok', 'yes', 'continue', 'great', 'Break this down',
      'Sounds good', 'Perfect, let\'s do it', 'haha', 'lol', 'wow',
    ];
    for (const msg of skipMessages) {
      const r = classify(msg);
      expect(r.intent).toBe('SKIP');
      expect(r.confidenceThreshold).toBeNull();
    }
  });

  it('AC14: Mixed-intent messages get raised threshold (0.60-0.65)', () => {
    const mixed = classify("Let's spec out the 3 levels we defined earlier.");
    expect(mixed.confidenceThreshold).toBeGreaterThanOrEqual(0.60);
    expect(mixed.confidenceThreshold).toBeLessThanOrEqual(0.65);
  });
});

// ==========================================================================
// 2. Signal Scoring: Directive
// ==========================================================================
describe('scoreDirective', () => {
  it('pure directives score 1.0', () => {
    expect(scoreDirective('thoughts', 8)).toBe(1.0);
    expect(scoreDirective('continue', 8)).toBe(1.0);
    expect(scoreDirective('yes', 3)).toBe(1.0);
    expect(scoreDirective('sounds good', 11)).toBe(1.0);
    expect(scoreDirective("let's do it", 11)).toBe(1.0);
  });

  it('emotional responses score 1.0', () => {
    expect(scoreDirective('haha', 4)).toBe(1.0);
    expect(scoreDirective('lol', 3)).toBe(1.0);
    expect(scoreDirective('wow', 3)).toBe(1.0);
    expect(scoreDirective('omg', 3)).toBe(1.0);
  });

  it('compound directives score 1.0', () => {
    expect(scoreDirective("perfect, let's do it", 20)).toBe(1.0);
    expect(scoreDirective('great, move on', 14)).toBe(1.0);
    expect(scoreDirective('ok, go ahead', 12)).toBe(1.0);
  });

  it('action directives score >= 0.8', () => {
    expect(scoreDirective('break this down', 15)).toBeGreaterThanOrEqual(0.8);
    expect(scoreDirective('review this', 11)).toBeGreaterThanOrEqual(0.8);
    expect(scoreDirective('analyze this for me', 19)).toBeGreaterThanOrEqual(0.8);
  });

  it('announcement patterns score >= 0.7', () => {
    expect(scoreDirective("here's the plan", 15)).toBeGreaterThanOrEqual(0.7);
    expect(scoreDirective("i'll share the details", 22)).toBeGreaterThanOrEqual(0.7);
    expect(scoreDirective("then i will share what the dev's plan is from the previous chat.", 64)).toBeGreaterThanOrEqual(0.7);
    expect(scoreDirective('fyi for your reference', 22)).toBeGreaterThanOrEqual(0.7);
  });

  it('memory queries score low on directive', () => {
    expect(scoreDirective('what is my favorite painting?', 29)).toBeLessThan(0.4);
    expect(scoreDirective('do you remember what i said about lambo doors?', 46)).toBeLessThan(0.4);
  });
});

// ==========================================================================
// 3. Signal Scoring: Memory Reference
// ==========================================================================
describe('scoreMemoryReference', () => {
  it('strong memory queries score >= 0.9', () => {
    expect(scoreMemoryReference('what is my favorite painting?')).toBeGreaterThanOrEqual(0.9);
    expect(scoreMemoryReference('do you remember what i said?')).toBeGreaterThanOrEqual(0.9);
    expect(scoreMemoryReference('what did we discuss about scoring?')).toBeGreaterThanOrEqual(0.9);
    expect(scoreMemoryReference('remind me about the plan')).toBeGreaterThanOrEqual(0.9);
  });

  it('moderate memory signals score >= 0.6', () => {
    expect(scoreMemoryReference('we defined three levels earlier')).toBeGreaterThanOrEqual(0.6);
    expect(scoreMemoryReference('you said something about architectures')).toBeGreaterThanOrEqual(0.6);
    expect(scoreMemoryReference('remember when we discussed that?')).toBeGreaterThanOrEqual(0.6);
  });

  it('weak personal context scores ~0.35', () => {
    expect(scoreMemoryReference('help me with my project')).toBeGreaterThanOrEqual(0.3);
    expect(scoreMemoryReference('help me with my project')).toBeLessThan(0.6);
  });

  it('generic messages score 0', () => {
    expect(scoreMemoryReference('how do i structure the onboarding flow?')).toBe(0);
    expect(scoreMemoryReference('break this down for me')).toBe(0);
    expect(scoreMemoryReference('thoughts?')).toBe(0);
  });
});

// ==========================================================================
// 4. Signal Scoring: Content Density
// ==========================================================================
describe('scoreContentDensity', () => {
  it('very short messages have zero/low density', () => {
    expect(scoreContentDensity('hi')).toBe(0.0);
    expect(scoreContentDensity('ok sure thing')).toBe(0.15);
    expect(scoreContentDensity('yes that works for me')).toBe(0.15); // 21 chars < 25
  });

  it('query-length messages have high density', () => {
    expect(scoreContentDensity('What is my favorite painting and why do I like it?')).toBe(0.7);
    expect(scoreContentDensity('How should I structure the onboarding flow for new users?')).toBe(0.7);
  });

  it('pasted code blocks have low density', () => {
    const code = '```\n' + 'function foo() { return bar; }\n'.repeat(10) + '```';
    expect(scoreContentDensity(code)).toBe(0.1);
  });

  it('multi-line pasted content with short tail has low density', () => {
    const pasted = ('Some documentation line here.\n').repeat(15) + 'Thoughts?';
    expect(scoreContentDensity(pasted)).toBe(0.1);
  });

  it('very long single-block messages have reduced density', () => {
    const longMsg = 'word '.repeat(80);
    expect(scoreContentDensity(longMsg)).toBe(0.3);
  });
});

// ==========================================================================
// 5. Signal Scoring: Question Structure
// ==========================================================================
describe('scoreQuestionStructure', () => {
  it('question marks score >= 0.6', () => {
    expect(scoreQuestionStructure('is this working?')).toBeGreaterThanOrEqual(0.6);
  });

  it('interrogative starts score >= 0.7', () => {
    expect(scoreQuestionStructure('what is the plan?')).toBeGreaterThanOrEqual(0.7);
    expect(scoreQuestionStructure('how do i fix this?')).toBeGreaterThanOrEqual(0.7);
    expect(scoreQuestionStructure('where should i put the file?')).toBeGreaterThanOrEqual(0.7);
  });

  it('imperatives with retrieval flavor score ~0.5', () => {
    expect(scoreQuestionStructure('tell me about the scoring pipeline')).toBeGreaterThanOrEqual(0.5);
    expect(scoreQuestionStructure('show me the results')).toBeGreaterThanOrEqual(0.5);
  });

  it('directives score 0', () => {
    expect(scoreQuestionStructure('continue')).toBe(0);
    expect(scoreQuestionStructure('break this down')).toBe(0);
    expect(scoreQuestionStructure('sounds good')).toBe(0);
  });
});

// ==========================================================================
// 6. Signal Scoring: Personal Reference
// ==========================================================================
describe('scorePersonalReference', () => {
  it('multiple "my" scores >= 0.6', () => {
    expect(scorePersonalReference('my project and my team')).toBeGreaterThanOrEqual(0.6);
  });

  it('single "my" scores ~0.3', () => {
    const s = scorePersonalReference('help with my project');
    expect(s).toBeGreaterThanOrEqual(0.3);
    expect(s).toBeLessThan(0.5);
  });

  it('"I said/built/decided" scores >= 0.5', () => {
    expect(scorePersonalReference('I decided to use react')).toBeGreaterThanOrEqual(0.5);
    expect(scorePersonalReference('I built that last week')).toBeGreaterThanOrEqual(0.5);
  });

  it('"we discussed/defined" scores >= 0.5', () => {
    expect(scorePersonalReference('we defined three levels')).toBeGreaterThanOrEqual(0.5);
    expect(scorePersonalReference('we agreed on this approach')).toBeGreaterThanOrEqual(0.5);
  });

  it('no personal reference scores 0', () => {
    expect(scorePersonalReference('how to structure onboarding')).toBe(0);
  });
});

// ==========================================================================
// 7. Signal Scoring: Temporal Reference
// ==========================================================================
describe('scoreTemporalReference', () => {
  it('specific time references score >= 0.7', () => {
    expect(scoreTemporalReference('yesterday I fixed it')).toBeGreaterThanOrEqual(0.7);
    expect(scoreTemporalReference('last week we discussed this')).toBeGreaterThanOrEqual(0.7);
    expect(scoreTemporalReference('earlier today I noticed')).toBeGreaterThanOrEqual(0.7);
  });

  it('"remember when" scores >= 0.8', () => {
    expect(scoreTemporalReference('remember when we built that?')).toBeGreaterThanOrEqual(0.8);
  });

  it('vague temporal words score ~0.4', () => {
    const s = scoreTemporalReference('before we had this issue');
    expect(s).toBeGreaterThanOrEqual(0.4);
    expect(s).toBeLessThan(0.7);
  });

  it('no temporal reference scores 0', () => {
    expect(scoreTemporalReference('how do I fix the bug?')).toBe(0);
  });
});

// ==========================================================================
// 8. Classification Logic — Edge Cases
// ==========================================================================
describe('Classification Logic', () => {
  it('empty/null input → SKIP empty_or_invalid', () => {
    expect(classify('').intent).toBe('SKIP');
    expect(classify(null).intent).toBe('SKIP');
    expect(classify(undefined).intent).toBe('SKIP');
    expect(classify('').reason).toBe('empty_or_invalid');
  });

  it('very short messages → SKIP too_short', () => {
    expect(classify('hi').intent).toBe('SKIP');
    expect(classify('ok').intent).toBe('SKIP');
    expect(classify('nope').intent).toBe('SKIP');
  });

  it('"Sounds good" → SKIP directive', () => {
    const r = classify('Sounds good');
    expect(r.intent).toBe('SKIP');
    expect(r.reason).toBe('directive');
  });

  it('personal + temporal → QUERY 0.45', () => {
    const r = classify('That car I mentioned last week was a Jeep.');
    expect(r.intent).toBe('QUERY');
    expect(r.confidenceThreshold).toBeLessThanOrEqual(0.50);
  });

  it('question + personal → QUERY 0.45', () => {
    const r = classify('What did I say about the architecture?');
    expect(r.intent).toBe('QUERY');
    expect(r.confidenceThreshold).toBeLessThanOrEqual(0.50);
  });

  it('directive + temporal → QUERY 0.60', () => {
    const r = classify("Continue where we left off yesterday");
    expect(r.intent).toBe('QUERY');
    expect(r.confidenceThreshold).toBe(0.60);
    expect(r.reason).toBe('mixed_directive_temporal');
  });

  it('generic question with no personal signal → PASSIVE 0.60', () => {
    const r = classify('What are the best practices for API design?');
    expect(r.intent).toBe('PASSIVE');
    expect(r.confidenceThreshold).toBe(0.60);
  });

  it('substantive statement with no signals → PASSIVE 0.60', () => {
    const r = classify('The scoring pipeline needs better entity handling for compound nouns.');
    expect(r.intent).toBe('PASSIVE');
    expect(r.confidenceThreshold).toBe(0.60);
  });

  it('"I only read thought books." → SKIP (personal declaration, no retrieval signals)', () => {
    const r = classify('I only read thought books.');
    expect(r.intent).toBe('SKIP');
    expect(r.reason).toBe('no_signal');
    expect(r.scores.density).toBe(0.7);     // 5 words → density sweet spot
    expect(r.scores.memory).toBe(0);
    expect(r.scores.question).toBe(0);
    expect(r.scores.personal).toBe(0);
    expect(r.scores.temporal).toBe(0);
  });

  it('short generic declarations → SKIP (density-only insufficient)', () => {
    // 5-7 word statements with no retrieval signals
    expect(classify('Python is a great programming language.').intent).toBe('SKIP');
    expect(classify('The weather is nice today.').intent).toBe('SKIP');
    expect(classify('I really enjoy building things.').intent).toBe('SKIP');
  });

  it('8+ word statements still get PASSIVE even without explicit signals', () => {
    // Long enough to be substantive — worth attempting retrieval
    const r = classify('I think the authentication module needs a complete overhaul soon.');
    expect(r.intent).toBe('PASSIVE');
    expect(r.confidenceThreshold).toBe(0.60);
  });

  it('low density without memory → SKIP', () => {
    // Short, non-directive, non-question — just a fragment
    const r = classify('well okay then');
    expect(r.intent).toBe('SKIP');
  });
});

// ==========================================================================
// 9. Spec-documented Problem Cases (section 7 table)
// ==========================================================================
describe('Problem Cases from Spec', () => {
  it('"Review this" + 2000 word paste → SKIP', () => {
    const longDoc = 'Review this\n' + 'Lorem ipsum dolor sit amet consectetur. '.repeat(300);
    const r = classify(longDoc);
    expect(r.intent).toBe('SKIP');
  });

  it('"What did we discuss about the scoring pipeline?" → QUERY 0.40', () => {
    const r = classify('What did we discuss about the scoring pipeline?');
    expect(r.intent).toBe('QUERY');
    expect(r.confidenceThreshold).toBe(0.40);
    expect(r.reason).toBe('explicit_memory_query');
  });

  it('"Sounds good" → SKIP', () => {
    const r = classify('Sounds good');
    expect(r.intent).toBe('SKIP');
  });

  it('"Do you remember what I said about Lambo doors?" → QUERY 0.40', () => {
    const r = classify('Do you remember what I said about Lambo doors?');
    expect(r.intent).toBe('QUERY');
    expect(r.confidenceThreshold).toBe(0.40);
  });
});

// ==========================================================================
// 10. Return Shape Consistency
// ==========================================================================
describe('Return Shape', () => {
  it('SKIP results have null confidenceThreshold', () => {
    const r = classify('yes');
    expect(r.intent).toBe('SKIP');
    expect(r.confidenceThreshold).toBeNull();
  });

  it('QUERY results have numeric confidenceThreshold', () => {
    const r = classify('What is my favorite painting?');
    expect(r.intent).toBe('QUERY');
    expect(typeof r.confidenceThreshold).toBe('number');
    expect(r.confidenceThreshold).toBeGreaterThan(0);
    expect(r.confidenceThreshold).toBeLessThanOrEqual(1.0);
  });

  it('PASSIVE results have 0.60 confidenceThreshold', () => {
    const r = classify('How should I structure the onboarding flow?');
    expect(r.intent).toBe('PASSIVE');
    expect(r.confidenceThreshold).toBe(0.60);
  });

  it('all results have reason string', () => {
    for (const msg of ['yes', 'What is my favorite car?', 'How do I build a pipeline?']) {
      const r = classify(msg);
      expect(typeof r.reason).toBe('string');
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });
});
