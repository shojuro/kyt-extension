/**
 * Unit Tests for Assistant Quality Detector
 *
 * Tests deflection detection, echo detection, confidence scoring,
 * penalty arithmetic, and the assistant-block extraction regex.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectDeflection,
  applyDeflectionPenalty,
  updateConfig,
  __testing__
} from '../../src/assistant-quality-detector.js';

const { DEFLECTION_PATTERNS, ECHO_PATTERNS, DETECTOR_CONFIG } = __testing__;

// ---------------------------------------------------------------------------
// Helper: pad text to a target length with realistic filler
// ---------------------------------------------------------------------------
function padTo(text, targetLength) {
  const filler = ' The system processed the request and returned additional context from the stored conversation history for completeness.';
  while (text.length < targetLength) {
    text += filler;
  }
  return text;
}

// ---------------------------------------------------------------------------
// Helper: extract assistant blocks using the same regex as background.js
// (lines 784, 1395, 1464). Defined inline since it isn't exported from a module.
// ---------------------------------------------------------------------------
function extractAssistantBlocks(content) {
  const re = /(?:^|\n\n)Assistant:\s*([\s\S]*?)(?=\n\nUser:|\s*$)/gi;
  const blocks = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    blocks.push(m[1].trim());
  }
  return blocks;
}

// ===========================================================================
describe('Assistant Quality Detector', () => {
  beforeEach(() => {
    // Reset config to defaults before each test
    updateConfig({
      shortMessageLength: 200,
      longMessageLength: 400,
      openingWindowChars: 150,
      debugMode: false
    });
  });

  // =========================================================================
  // 1. Phase 3b Regression Fixtures — the 3 texts that were leaking through
  // =========================================================================
  describe('Phase 3b Regression Fixtures', () => {
    const LEAK_A = 'no answer or preference was actually captured';
    const LEAK_B = "there's no stored record of what your favorite car is";
    const LEAK_C_PREFIX = "Your stored conversations still don't have a direct answer about your favorite car";

    it('should detect "no answer or preference was actually captured" (short)', () => {
      const result = detectDeflection(LEAK_A, 'assistant');
      expect(result.isDeflection).toBe(true);
      expect(result.confidence).toBe(0.95);
      expect(LEAK_A.length).toBeLessThan(200); // guard: confirm short
    });

    it('should detect "there\'s no stored record of..." (short)', () => {
      const result = detectDeflection(LEAK_B, 'assistant');
      expect(result.isDeflection).toBe(true);
      expect(result.confidence).toBe(0.95);
      expect(LEAK_B.length).toBeLessThan(200);
    });

    it('should detect padded LEAK_A at medium confidence (single pattern)', () => {
      const medium = padTo(LEAK_A, 250);
      expect(medium.length).toBeGreaterThanOrEqual(200);
      expect(medium.length).toBeLessThanOrEqual(400);
      const result = detectDeflection(medium, 'assistant');
      expect(result.isDeflection).toBe(true);
      expect(result.confidence).toBe(0.65);
    });

    it('should detect LEAK_C with two patterns at high confidence', () => {
      // Combines "don't have a direct answer about" + "stored conversations ... don't have"
      const text = LEAK_C_PREFIX + ". The stored data don't have any relevant preference for this topic.";
      const result = detectDeflection(text, 'assistant');
      expect(result.isDeflection).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    });
  });

  // =========================================================================
  // 2. First-Person Patterns (regression guard for original patterns)
  // =========================================================================
  describe('First-Person Patterns', () => {
    it('should detect "I don\'t have access to your personal preferences"', () => {
      const result = detectDeflection(
        "I don't have access to your personal preferences",
        'assistant'
      );
      expect(result.isDeflection).toBe(true);
    });

    it('should detect "I couldn\'t find any relevant information"', () => {
      const result = detectDeflection(
        "I couldn't find any relevant information",
        'assistant'
      );
      expect(result.isDeflection).toBe(true);
    });

    it('should detect "Unfortunately, I can\'t access your data"', () => {
      const result = detectDeflection(
        "Unfortunately, I can't access your data",
        'assistant'
      );
      expect(result.isDeflection).toBe(true);
    });

    it('should detect "I\'m sorry, but I don\'t have that information"', () => {
      const result = detectDeflection(
        "I'm sorry, but I don't have that information about your preferences",
        'assistant'
      );
      expect(result.isDeflection).toBe(true);
    });
  });

  // =========================================================================
  // 3. False Positive Guard — must NOT match
  // =========================================================================
  describe('False Positive Guard', () => {
    it('should NOT flag "I love my favorite car, the Lamborghini"', () => {
      const result = detectDeflection(
        'I love my favorite car, the Lamborghini FenoMeno',
        'assistant'
      );
      expect(result.isDeflection).toBe(false);
    });

    it('should NOT flag "Jerry is my friend from college"', () => {
      const result = detectDeflection(
        'Jerry is my friend from college',
        'assistant'
      );
      expect(result.isDeflection).toBe(false);
    });

    it('should NOT flag "The answer is stored in the database for reference"', () => {
      const result = detectDeflection(
        'The answer is stored in the database for reference',
        'assistant'
      );
      expect(result.isDeflection).toBe(false);
    });

    it('should NOT flag a substantive assistant response about preferences', () => {
      const result = detectDeflection(
        'Based on your conversations, your favorite car is a Lamborghini. You mentioned it several times in the past week.',
        'assistant'
      );
      expect(result.isDeflection).toBe(false);
    });
  });

  // =========================================================================
  // 4. Confidence Scoring Tiers — length-based severity
  // =========================================================================
  describe('Confidence Scoring Tiers', () => {
    const deflectionPhrase = "I don't have access to your personal data";

    it('should score 0.95 for short messages (< 200 chars)', () => {
      expect(deflectionPhrase.length).toBeLessThan(200);
      const result = detectDeflection(deflectionPhrase, 'assistant');
      expect(result.confidence).toBe(0.95);
    });

    it('should score 0.65 for medium messages (200-400 chars) with 1 pattern', () => {
      const medium = padTo(deflectionPhrase, 250);
      expect(medium.length).toBeGreaterThanOrEqual(200);
      expect(medium.length).toBeLessThanOrEqual(400);
      const result = detectDeflection(medium, 'assistant');
      expect(result.confidence).toBe(0.65);
    });

    it('should score 0.85 for medium messages with 2+ patterns', () => {
      const twoPatterns = "I don't have access to your data. I couldn't find any specific records about this topic.";
      const medium = padTo(twoPatterns, 250);
      expect(medium.length).toBeGreaterThanOrEqual(200);
      expect(medium.length).toBeLessThanOrEqual(400);
      const result = detectDeflection(medium, 'assistant');
      expect(result.confidence).toBe(0.85);
    });

    it('should score 0.30 for long messages with pattern only in opening', () => {
      // Pattern in first 150 chars, then 400+ chars of substance
      const opening = "I don't have access to your complete history, but here's what I found: ";
      const substance = 'x'.repeat(400);
      const longMsg = opening + substance;
      expect(longMsg.length).toBeGreaterThan(400);
      expect(opening.length).toBeLessThan(150);
      const result = detectDeflection(longMsg, 'assistant');
      expect(result.confidence).toBe(0.30);
    });
  });

  // =========================================================================
  // 5. Echo Patterns — via detectDeflection()
  // =========================================================================
  describe('Echo Patterns', () => {
    it('should detect "So you\'re asking about your favorite car"', () => {
      const result = detectDeflection(
        "So you're asking about your favorite car",
        'assistant'
      );
      expect(result.isDeflection).toBe(true);
      expect(result.reason).toContain('echo');
    });

    it('should detect "It sounds like you want to know about..."', () => {
      const result = detectDeflection(
        'It sounds like you want to know about your previous conversations',
        'assistant'
      );
      expect(result.isDeflection).toBe(true);
      expect(result.reason).toContain('echo');
    });

    it('should detect "If I understand correctly, you..."', () => {
      const result = detectDeflection(
        'If I understand correctly, you want details about Jerry',
        'assistant'
      );
      expect(result.isDeflection).toBe(true);
    });

    // Note: "You said..." and "You mentioned..." echo patterns live only in
    // background.js's inline ECHO_PATTERNS array, not in the detector module.
    // Testing those requires Chrome mock setup — separate effort.
  });

  // =========================================================================
  // 6. applyDeflectionPenalty Arithmetic
  // =========================================================================
  describe('applyDeflectionPenalty', () => {
    it('should apply 0.145 multiplier for confidence 0.95', () => {
      const item = { cross_encoder_score: 1.0, weighted_score: 1.0, rrf_score: 1.0 };
      applyDeflectionPenalty(item, 0.95);
      const expected = 1 - (0.95 * 0.9); // 0.145
      expect(item.cross_encoder_score).toBeCloseTo(expected, 4);
      expect(item.weighted_score).toBeCloseTo(expected, 4);
      expect(item.rrf_score).toBeCloseTo(expected, 4);
    });

    it('should apply 0.415 multiplier for confidence 0.65', () => {
      const item = { cross_encoder_score: 0.8 };
      applyDeflectionPenalty(item, 0.65);
      const expected = 0.8 * (1 - (0.65 * 0.9)); // 0.8 * 0.415
      expect(item.cross_encoder_score).toBeCloseTo(expected, 4);
    });

    it('should apply 0.73 multiplier for confidence 0.30', () => {
      const item = { weighted_score: 0.6 };
      applyDeflectionPenalty(item, 0.30);
      const expected = 0.6 * (1 - (0.30 * 0.9)); // 0.6 * 0.73
      expect(item.weighted_score).toBeCloseTo(expected, 4);
    });

    it('should invert distance correctly (distance=0.3 → similarity=0.7)', () => {
      const item = { distance: 0.3 };
      applyDeflectionPenalty(item, 0.95);
      // similarity = 1 - 0.3 = 0.7
      // penalized similarity = 0.7 * 0.145 = 0.1015
      // new distance = 1 - 0.1015 = 0.8985
      expect(item.distance).toBeCloseTo(0.8985, 4);
    });

    it('should not modify item when confidence is 0', () => {
      const item = { cross_encoder_score: 0.9, distance: 0.2 };
      applyDeflectionPenalty(item, 0);
      expect(item.cross_encoder_score).toBe(0.9);
      expect(item.distance).toBe(0.2);
    });

    it('should skip null/undefined score fields gracefully', () => {
      const item = { cross_encoder_score: null, weighted_score: undefined, rrf_score: 0.5 };
      applyDeflectionPenalty(item, 0.95);
      expect(item.cross_encoder_score).toBeNull();
      expect(item.weighted_score).toBeUndefined();
      expect(item.rrf_score).toBeCloseTo(0.5 * 0.145, 4);
    });
  });

  // =========================================================================
  // 7. Multi-Paragraph Assistant Extraction (lazy quantifier validation)
  // =========================================================================
  describe('Multi-Paragraph Assistant Extraction', () => {
    // Tests the regex /(?:^|\n\n)Assistant:\s*([\s\S]*?)(?=\n\nUser:|\s*$)/gi
    // used in background.js at lines 784, 1395, 1464.
    // Defined inline via extractAssistantBlocks() helper at top of file.

    it('should capture a 3-paragraph assistant block (lazy *? must not truncate)', () => {
      const content = [
        'Assistant: First paragraph of the response.',
        '',
        'Second paragraph continues here.',
        '',
        'Third paragraph wraps up.',
        '',
        'User: Thanks!'
      ].join('\n');
      const blocks = extractAssistantBlocks(content);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toContain('First paragraph');
      expect(blocks[0]).toContain('Second paragraph');
      expect(blocks[0]).toContain('Third paragraph');
    });

    it('should capture assistant block at end of string (no following User:)', () => {
      const content = 'Assistant: This is the entire response with no follow-up.';
      const blocks = extractAssistantBlocks(content);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toBe('This is the entire response with no follow-up.');
    });

    it('should extract 2 separate assistant blocks from multi-turn content', () => {
      const content = [
        'User: What is X?',
        '',
        'Assistant: X is a variable.',
        '',
        'User: And Y?',
        '',
        'Assistant: Y is another variable.'
      ].join('\n');
      const blocks = extractAssistantBlocks(content);
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toBe('X is a variable.');
      expect(blocks[1]).toBe('Y is another variable.');
    });

    it('should NOT truncate on single newlines within assistant block', () => {
      const content = [
        'Assistant: Line one.',
        'Line two (single newline, same block).',
        'Line three.',
        '',
        'User: Next question.'
      ].join('\n');
      const blocks = extractAssistantBlocks(content);
      expect(blocks).toHaveLength(1);
      // Single newlines are within the block — all 3 lines captured
      expect(blocks[0]).toContain('Line one.');
      expect(blocks[0]).toContain('Line two');
      expect(blocks[0]).toContain('Line three.');
    });

    it('should handle content with no assistant blocks', () => {
      const content = 'User: Just a user message with no assistant response.';
      const blocks = extractAssistantBlocks(content);
      expect(blocks).toHaveLength(0);
    });
  });

  // =========================================================================
  // 8. Role Gate — detectDeflection only fires for role='assistant'
  // =========================================================================
  describe('Role Gate', () => {
    const deflectionText = "I don't have access to your data";

    it('should return false for role="user" even with deflection text', () => {
      const result = detectDeflection(deflectionText, 'user');
      expect(result.isDeflection).toBe(false);
      expect(result.confidence).toBe(0);
    });

    it('should return false for role=undefined', () => {
      const result = detectDeflection(deflectionText, undefined);
      expect(result.isDeflection).toBe(false);
    });

    it('should return false for empty content with role="assistant"', () => {
      const result = detectDeflection('', 'assistant');
      expect(result.isDeflection).toBe(false);
    });

    it('should return false for null content with role="assistant"', () => {
      const result = detectDeflection(null, 'assistant');
      expect(result.isDeflection).toBe(false);
    });
  });
});
