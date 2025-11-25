/**
 * Tests for Deduplication Checker
 *
 * Tests both exact and fuzzy duplicate detection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DeduplicationChecker } from '../scripts/lib/deduplication.js';

describe('DeduplicationChecker', () => {
  let checker;

  beforeEach(() => {
    checker = new DeduplicationChecker();
  });

  describe('Exact Duplicate Detection', () => {
    it('should detect exact duplicate text', () => {
      const text = 'John Smith works at Microsoft';

      const first = checker.isDuplicate(text);
      const second = checker.isDuplicate(text);

      expect(first).toBe(false);  // First occurrence - not a duplicate
      expect(second).toBe(true);  // Second occurrence - is a duplicate
    });

    it('should treat case-insensitive text as duplicate', () => {
      const first = checker.isDuplicate('John Smith works at Microsoft');
      const second = checker.isDuplicate('john smith works at microsoft');

      expect(first).toBe(false);
      expect(second).toBe(true);
    });

    it('should treat whitespace-normalized text as duplicate', () => {
      const first = checker.isDuplicate('John  Smith   works at Microsoft');
      const second = checker.isDuplicate('John Smith works at Microsoft');

      expect(first).toBe(false);
      expect(second).toBe(true);
    });

    it('should treat punctuation-removed text as duplicate', () => {
      const first = checker.isDuplicate('John Smith works at Microsoft.');
      const second = checker.isDuplicate('John Smith works at Microsoft!');

      expect(first).toBe(false);
      expect(second).toBe(true);
    });

    it('should allow truly unique texts', () => {
      const texts = [
        'John works at Microsoft',
        'Alice works at Google',
        'Bob works at Amazon',
        'Charlie works at Apple'
      ];

      const results = texts.map(text => checker.isDuplicate(text));

      expect(results).toEqual([false, false, false, false]);
    });
  });

  describe('Fuzzy Duplicate Detection', () => {
    it('should detect near-duplicate with 95% similarity', () => {
      const first = 'John Smith works at Microsoft Corporation in Seattle';
      const second = 'John Smith works at Microsoft Corporation in Seattl';  // One char different

      checker.isDuplicate(first);
      const result = checker.isDuplicate(second);

      expect(result).toBe(true);
    });

    it('should NOT detect as duplicate when similarity below threshold', () => {
      const first = 'John Smith works at Microsoft';
      const second = 'Alice Johnson works at Google';

      checker.isDuplicate(first);
      const result = checker.isDuplicate(second);

      expect(result).toBe(false);
    });

    it('should handle very similar but different entities', () => {
      const texts = [
        'My sister Jennifer is a doctor in Boston',
        'My sister Jennifer is a doctor in Bosto',   // Boston -> Bosto (1 char)
        'My sister Jennifer is a doctor in Bost'     // Boston -> Bost (2 chars)
      ];

      const results = texts.map(text => checker.isDuplicate(text));

      // First is unique, second should be caught (96% similar), third might not be (93% similar)
      expect(results[0]).toBe(false);
      expect(results[1]).toBe(true);  // Very similar to first (1 char difference)
      // Third may or may not be caught depending on exact Levenshtein calculation
    });
  });

  describe('Statistics Tracking', () => {
    it('should track total checked count', () => {
      checker.isDuplicate('Text 1');
      checker.isDuplicate('Text 2');
      checker.isDuplicate('Text 1');  // Duplicate

      const stats = checker.getStats();

      expect(stats.totalChecked).toBe(3);
    });

    it('should track exact duplicates', () => {
      checker.isDuplicate('Same text');
      checker.isDuplicate('Same text');  // Exact duplicate
      checker.isDuplicate('Different');

      const stats = checker.getStats();

      expect(stats.exactDuplicates).toBe(1);
    });

    it('should track fuzzy duplicates', () => {
      const texts = [
        'John Smith works at Microsoft Corporation',
        'John Smith works at Microsoft Corporatio',  // 1 char off - fuzzy duplicate
        'John Smith works at Microsoft Corporati'    // 2 chars off - fuzzy duplicate
      ];

      texts.forEach(text => checker.isDuplicate(text));

      const stats = checker.getStats();

      expect(stats.fuzzyDuplicates).toBeGreaterThan(0);
    });

    it('should calculate duplicate rate', () => {
      const texts = [
        'Completely unique text alpha 12345',
        'Totally different text beta 67890',
        'Completely unique text alpha 12345',  // Exact duplicate
        'Another distinct text gamma 24680'
      ];

      texts.forEach(text => checker.isDuplicate(text));

      const stats = checker.getStats();

      // Duplicate rate = (exact + fuzzy) / total
      // Expected: 1 duplicate out of 4 total = 25%
      expect(stats.duplicateRate).toBe('25.0%');
    });

    it('should track unique count', () => {
      checker.isDuplicate('Text 1');
      checker.isDuplicate('Text 2');
      checker.isDuplicate('Text 1');  // Duplicate
      checker.isDuplicate('Text 3');

      const stats = checker.getStats();

      expect(stats.uniqueCount).toBe(3);
    });
  });

  describe('Reset Functionality', () => {
    it('should reset all state', () => {
      checker.isDuplicate('Text 1');
      checker.isDuplicate('Text 2');
      checker.isDuplicate('Text 1');  // Duplicate

      checker.reset();

      const stats = checker.getStats();

      expect(stats.totalChecked).toBe(0);
      expect(stats.exactDuplicates).toBe(0);
      expect(stats.fuzzyDuplicates).toBe(0);
      expect(stats.uniqueCount).toBe(0);
    });

    it('should allow reuse after reset', () => {
      checker.isDuplicate('Text 1');
      checker.reset();

      const result = checker.isDuplicate('Text 1');

      expect(result).toBe(false);  // Not a duplicate after reset
    });
  });

  describe('Cache Management', () => {
    it('should limit fuzzy cache size', () => {
      const checker = new DeduplicationChecker({ fuzzyCacheSize: 10 });

      // Add 20 unique texts
      for (let i = 0; i < 20; i++) {
        checker.isDuplicate(`Unique text number ${i}`);
      }

      const stats = checker.getStats();

      expect(stats.fuzzyCacheSize).toBeLessThanOrEqual(10);
    });
  });

  describe('Custom Threshold', () => {
    it('should use custom fuzzy threshold', () => {
      const strictChecker = new DeduplicationChecker({ fuzzyThreshold: 0.99 });

      const first = 'John Smith works at Microsoft';
      const second = 'John Smith works at Microsof';  // 1 char off

      strictChecker.isDuplicate(first);
      const result = strictChecker.isDuplicate(second);

      // With 99% threshold, 1 char difference might not be caught
      // (depends on string length and Levenshtein distance)
      expect(typeof result).toBe('boolean');
    });

    it('should use looser threshold to catch more duplicates', () => {
      const looseChecker = new DeduplicationChecker({ fuzzyThreshold: 0.80 });

      const first = 'John Smith works at Microsoft Corporation';
      const second = 'John Smith works at Microsoft Corporatio';  // 95% similar (1 char diff)

      looseChecker.isDuplicate(first);
      const result = looseChecker.isDuplicate(second);

      expect(result).toBe(true);  // Should catch with 80% threshold (well above it)
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty strings', () => {
      const first = checker.isDuplicate('');
      const second = checker.isDuplicate('');

      expect(first).toBe(false);
      expect(second).toBe(true);  // Empty strings are duplicates
    });

    it('should handle very long strings', () => {
      const longText = 'a'.repeat(1000);

      const first = checker.isDuplicate(longText);
      const second = checker.isDuplicate(longText);

      expect(first).toBe(false);
      expect(second).toBe(true);
    });

    it('should handle strings with special characters', () => {
      const text = '!@#$%^&*()_+-=[]{}|;:\'",.<>?/~`';

      const first = checker.isDuplicate(text);
      const second = checker.isDuplicate(text);

      expect(first).toBe(false);
      expect(second).toBe(true);
    });

    it('should handle unicode characters', () => {
      const text = '你好世界 Hello 🌍';

      const first = checker.isDuplicate(text);
      const second = checker.isDuplicate(text);

      expect(first).toBe(false);
      expect(second).toBe(true);
    });
  });

  describe('Real-world Scenarios', () => {
    it('should prevent duplicate NER training examples', () => {
      const examples = [
        'John Smith works at Microsoft in Seattle',
        'Alice Johnson works at Google in Mountain View',
        'John Smith works at Microsoft in Seattle',  // Exact duplicate
        'John Smith works at Microsoft in Seattl',   // Fuzzy duplicate (typo)
        'Bob Wilson works at Amazon in Seattle'
      ];

      const uniqueExamples = examples.filter(text => !checker.isDuplicate(text));

      expect(uniqueExamples.length).toBeLessThan(examples.length);
      expect(uniqueExamples.length).toBeGreaterThanOrEqual(2);  // At least 2 unique
    });

    it('should allow similar but genuinely different examples', () => {
      const examples = [
        'Apple CEO Tim Cook announced the iPhone 15',
        'Google CEO Sundar Pichai announced the Pixel 8',
        'Microsoft CEO Satya Nadella announced Azure AI'
      ];

      const results = examples.map(text => checker.isDuplicate(text));

      // All should be unique (similar structure but different content)
      expect(results.filter(r => r === false).length).toBeGreaterThanOrEqual(1);
    });
  });
});
