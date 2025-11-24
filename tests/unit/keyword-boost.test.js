/**
 * Unit Tests for Keyword Boost Module
 *
 * Tests keyword coverage calculation and score boosting logic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyKeywordBoost,
  updateConfig,
  getConfig,
  __testing__
} from '../../src/keyword-boost.js';

const { extractQueryTerms, calculateCoverage, boostCandidate } = __testing__;

describe('Keyword Boost Module', () => {
  beforeEach(() => {
    // Reset configuration before each test
    updateConfig({
      boostFactor: 0.3,
      minTermLength: 3,
      enableBoost: true,
      debugMode: false
    });
  });

  describe('extractQueryTerms', () => {
    it('should extract meaningful terms from query', () => {
      const query = "Tell me about Jennifer's startup idea";
      const terms = extractQueryTerms(query);

      expect(terms).toContain('tell');
      expect(terms).toContain('about');
      expect(terms).toContain('jennifer');
      expect(terms).toContain('startup');
      expect(terms).toContain('idea');
    });

    it('should filter out stopwords', () => {
      const query = "What is the best way to configure PostgreSQL";
      const terms = extractQueryTerms(query);

      expect(terms).not.toContain('what');
      expect(terms).not.toContain('the');
      expect(terms).toContain('best');
      expect(terms).toContain('way');
      expect(terms).toContain('configure');
      expect(terms).toContain('postgresql');
    });

    it('should filter out short terms', () => {
      const query = "Go to the API";
      const terms = extractQueryTerms(query);

      expect(terms).not.toContain('go');
      expect(terms).not.toContain('to');
      expect(terms).toContain('api');
    });

    it('should handle empty query', () => {
      const terms = extractQueryTerms('');
      expect(terms).toEqual([]);
    });

    it('should handle query with only stopwords', () => {
      const query = "what is the and for";
      const terms = extractQueryTerms(query);
      expect(terms).toEqual([]);
    });
  });

  describe('calculateCoverage', () => {
    it('should calculate correct coverage for perfect match', () => {
      const queryTerms = ['jennifer', 'startup', 'idea'];
      const content = "Jennifer's startup idea involves AI tutoring";

      const coverage = calculateCoverage(queryTerms, content);

      expect(coverage.coverage).toBe(1.0);
      expect(coverage.matchedTerms).toBe(3);
      expect(coverage.totalTerms).toBe(3);
      expect(coverage.matchedTermsList).toEqual(['jennifer', 'startup', 'idea']);
    });

    it('should calculate correct coverage for partial match', () => {
      const queryTerms = ['jennifer', 'startup', 'idea'];
      const content = "Jennifer mentioned her startup at the meeting";

      const coverage = calculateCoverage(queryTerms, content);

      expect(coverage.coverage).toBeCloseTo(0.667, 2);
      expect(coverage.matchedTerms).toBe(2);
      expect(coverage.totalTerms).toBe(3);
      expect(coverage.matchedTermsList).toEqual(['jennifer', 'startup']);
    });

    it('should calculate zero coverage for no match', () => {
      const queryTerms = ['jennifer', 'startup', 'idea'];
      const content = "The weather is sunny today";

      const coverage = calculateCoverage(queryTerms, content);

      expect(coverage.coverage).toBe(0);
      expect(coverage.matchedTerms).toBe(0);
      expect(coverage.totalTerms).toBe(3);
      expect(coverage.matchedTermsList).toEqual([]);
    });

    it('should handle empty query terms', () => {
      const coverage = calculateCoverage([], "Some content");

      expect(coverage.coverage).toBe(0);
      expect(coverage.matchedTerms).toBe(0);
      expect(coverage.totalTerms).toBe(0);
      expect(coverage.matchedTermsList).toEqual([]);
    });

    it('should be case-insensitive', () => {
      const queryTerms = ['jennifer', 'startup'];
      const content = "JENNIFER founded a STARTUP";

      const coverage = calculateCoverage(queryTerms, content);

      expect(coverage.coverage).toBe(1.0);
      expect(coverage.matchedTerms).toBe(2);
    });
  });

  describe('boostCandidate', () => {
    it('should apply correct boost for 100% coverage', () => {
      const candidate = {
        message_id: 'msg_1',
        content: "Jennifer's startup idea involves AI tutoring",
        weighted_score: 0.70
      };
      const queryTerms = ['jennifer', 'startup', 'idea'];
      const boostFactor = 0.3;

      const boosted = boostCandidate(candidate, queryTerms, boostFactor);

      // 100% coverage * 0.3 = 30% boost
      // 0.70 * (1 + 0.30) = 0.70 * 1.30 = 0.91
      expect(boosted.weighted_score).toBeCloseTo(0.91, 2);
      expect(boosted.keyword_coverage).toBe(1.0);
      expect(boosted.keyword_boost).toBeCloseTo(0.3, 2);
      expect(boosted.keyword_matched_terms).toBe(3);
      expect(boosted.original_score).toBe(0.70);
    });

    it('should apply correct boost for 50% coverage', () => {
      const candidate = {
        message_id: 'msg_2',
        content: "Jennifer mentioned something at the meeting",
        weighted_score: 0.60
      };
      const queryTerms = ['jennifer', 'startup'];  // Only 'jennifer' matches
      const boostFactor = 0.3;

      const boosted = boostCandidate(candidate, queryTerms, boostFactor);

      // 50% coverage * 0.3 = 15% boost
      // 0.60 * (1 + 0.15) = 0.60 * 1.15 = 0.69
      expect(boosted.weighted_score).toBeCloseTo(0.69, 2);
      expect(boosted.keyword_coverage).toBe(0.5);
      expect(boosted.keyword_boost).toBeCloseTo(0.15, 2);
      expect(boosted.keyword_matched_terms).toBe(1);
    });

    it('should apply no boost for 0% coverage', () => {
      const candidate = {
        message_id: 'msg_3',
        content: "The weather is sunny today",
        weighted_score: 0.50
      };
      const queryTerms = ['jennifer', 'startup'];
      const boostFactor = 0.3;

      const boosted = boostCandidate(candidate, queryTerms, boostFactor);

      // 0% coverage * 0.3 = 0% boost
      expect(boosted.weighted_score).toBe(0.50);
      expect(boosted.keyword_coverage).toBe(0);
      expect(boosted.keyword_boost).toBe(0);
      expect(boosted.keyword_matched_terms).toBe(0);
    });
  });

  describe('applyKeywordBoost', () => {
    const testCandidates = [
      {
        message_id: 'msg_1',
        content: "Jennifer founded an AI tutoring startup called EduAI",
        weighted_score: 0.72
      },
      {
        message_id: 'msg_2',
        content: "The weather in Tokyo is sunny today",
        weighted_score: 0.68
      },
      {
        message_id: 'msg_3',
        content: "Jennifer mentioned her startup pitch deck at the investor meeting",
        weighted_score: 0.65
      }
    ];

    it('should boost and re-sort candidates correctly', () => {
      const query = "Tell me about Jennifer's startup idea";
      const results = applyKeywordBoost(query, testCandidates);

      // msg_1 has high coverage (jennifer, startup) → gets boosted
      // msg_3 has high coverage (jennifer, startup) → gets boosted
      // msg_2 has no coverage → no boost

      // Original scores: msg_1=0.72, msg_2=0.68, msg_3=0.65
      // After boost: msg_1 and msg_3 should rank higher than msg_2

      expect(results[0].message_id).toBe('msg_1');  // Highest coverage + high original score
      expect(results[1].message_id).toBe('msg_3');  // High coverage, lower original score
      expect(results[2].message_id).toBe('msg_2');  // No coverage

      // Verify boost was applied
      expect(results[0].keyword_coverage).toBeGreaterThan(0);
      expect(results[1].keyword_coverage).toBeGreaterThan(0);
      expect(results[2].keyword_coverage).toBe(0);
    });

    it('should handle empty candidates array', () => {
      const query = "Test query";
      const results = applyKeywordBoost(query, []);
      expect(results).toEqual([]);
    });

    it('should handle empty query', () => {
      const results = applyKeywordBoost('', testCandidates);
      expect(results).toEqual(testCandidates);
    });

    it('should handle query with no meaningful terms', () => {
      const query = "the and for";  // All stopwords
      const results = applyKeywordBoost(query, testCandidates);
      expect(results).toEqual(testCandidates);
    });

    it('should respect boost disabled flag', () => {
      updateConfig({ enableBoost: false });

      const query = "Jennifer's startup";
      const results = applyKeywordBoost(query, testCandidates);

      // Should return candidates unchanged
      expect(results).toEqual(testCandidates);
      expect(results[0].keyword_boost).toBeUndefined();
    });

    it('should respect custom boost factor', () => {
      const query = "Jennifer startup";
      const results = applyKeywordBoost(query, testCandidates, { boostFactor: 0.5 });

      // Higher boost factor = bigger score increase
      const msg1 = results.find(r => r.message_id === 'msg_1');
      expect(msg1.keyword_boost).toBeGreaterThan(0.3);  // More than default 0.3
    });
  });

  describe('Configuration API', () => {
    it('should update configuration', () => {
      updateConfig({ boostFactor: 0.5, debugMode: true });

      const config = getConfig();
      expect(config.boostFactor).toBe(0.5);
      expect(config.debugMode).toBe(true);
    });

    it('should get current configuration', () => {
      const config = getConfig();

      expect(config).toHaveProperty('boostFactor');
      expect(config).toHaveProperty('minTermLength');
      expect(config).toHaveProperty('enableBoost');
      expect(config).toHaveProperty('debugMode');
    });
  });

  describe('Entity Query Use Cases', () => {
    it('should boost entity query: "Jennifer\'s startup"', () => {
      const candidates = [
        {
          message_id: 'msg_1',
          content: "Jennifer founded an AI tutoring startup",
          weighted_score: 0.68
        },
        {
          message_id: 'msg_2',
          content: "The startup ecosystem is growing rapidly",
          weighted_score: 0.70
        }
      ];

      const query = "Jennifer's startup";
      const results = applyKeywordBoost(query, candidates);

      // msg_1 has both "Jennifer" and "startup" → 100% coverage
      // msg_2 has only "startup" → 50% coverage
      // With 30% boost: msg_1 = 0.68 * 1.3 = 0.884, msg_2 = 0.70 * 1.15 = 0.805
      expect(results[0].message_id).toBe('msg_1');
      expect(results[0].weighted_score).toBeGreaterThan(0.68);
      expect(results[0].keyword_coverage).toBe(1.0);
    });

    it('should boost entity query: "PostgreSQL configuration"', () => {
      const candidates = [
        {
          message_id: 'msg_1',
          content: "We discussed database configuration best practices",
          weighted_score: 0.68
        },
        {
          message_id: 'msg_2',
          content: "PostgreSQL configuration includes connection pooling settings",
          weighted_score: 0.64
        }
      ];

      const query = "PostgreSQL configuration";
      const results = applyKeywordBoost(query, candidates);

      // msg_2 has both "PostgreSQL" and "configuration" → should rank first
      expect(results[0].message_id).toBe('msg_2');
      expect(results[0].keyword_coverage).toBe(1.0);
    });

    it('should boost entity query: "Sarah\'s recommendation"', () => {
      const candidates = [
        {
          message_id: 'msg_1',
          content: "Sarah's recommendation was to use React hooks for state management",
          weighted_score: 0.67
        },
        {
          message_id: 'msg_2',
          content: "The recommendation was to use TypeScript",
          weighted_score: 0.70
        }
      ];

      const query = "Sarah's recommendation";
      const results = applyKeywordBoost(query, candidates);

      // msg_1 has both "Sarah" and "recommendation" → 100% coverage
      // msg_2 has only "recommendation" → 50% coverage
      // With 30% boost: msg_1 = 0.67 * 1.3 = 0.871, msg_2 = 0.70 * 1.15 = 0.805
      expect(results[0].message_id).toBe('msg_1');
      expect(results[0].keyword_coverage).toBeGreaterThan(results[1].keyword_coverage);
    });
  });
});
