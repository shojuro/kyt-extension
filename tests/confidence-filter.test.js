/**
 * Tests for Confidence Threshold Filter
 *
 * Tests the core filtering logic that implements "no results > wrong results"
 * philosophy for K.Y.T. Memory Extension Priority 2 feature.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { filterByConfidence, updateConfig, getConfig, __testing__ } from '../src/confidence-filter.js';

describe('Confidence Filter', () => {
  // Reset config before each test
  // Default threshold 0.40 tuned for Jina cross-encoder scores (0.0-1.0 calibrated)
  beforeEach(() => {
    updateConfig({ debugMode: false, defaultThreshold: 0.40 });
  });

  describe('filterByConfidence()', () => {
    it('should return success status when results pass threshold', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.85, content: 'High confidence match' },
        { message_id: 'b', cross_encoder_score: 0.72, content: 'Good match' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('success');
      expect(filtered.results).toHaveLength(2);
      expect(filtered.message).toContain('2 relevant memories');
      expect(filtered.highestScore).toBe(0.85);
    });

    it('should filter out results below threshold', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.85, content: 'High confidence' },
        { message_id: 'b', cross_encoder_score: 0.72, content: 'Above threshold' },
        { message_id: 'c', cross_encoder_score: 0.65, content: 'Below threshold' },
        { message_id: 'd', cross_encoder_score: 0.58, content: 'Low confidence' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('success');
      expect(filtered.results).toHaveLength(2);
      expect(filtered.results[0].message_id).toBe('a');
      expect(filtered.results[1].message_id).toBe('b');
    });

    it('should return low_confidence status when all results below threshold', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.68, content: 'Almost' },
        { message_id: 'b', cross_encoder_score: 0.65, content: 'Close' },
        { message_id: 'c', cross_encoder_score: 0.60, content: 'Not quite' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('low_confidence');
      expect(filtered.results).toHaveLength(0);
      expect(filtered.message).toContain('confidence was too low');
      expect(filtered.highestScore).toBe(0.68);
      expect(filtered.suggestions).toBeDefined();
      expect(Array.isArray(filtered.suggestions)).toBe(true);
    });

    it('should return no_results status for empty input', () => {
      const filtered = filterByConfidence([]);

      expect(filtered.status).toBe('no_results');
      expect(filtered.results).toHaveLength(0);
      expect(filtered.message).toContain('No matching memories');
    });

    it('should handle null/undefined input', () => {
      const filtered1 = filterByConfidence(null);
      const filtered2 = filterByConfidence(undefined);

      expect(filtered1.status).toBe('no_results');
      expect(filtered2.status).toBe('no_results');
    });

    it('should use default threshold of 0.40 when not specified', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.52, content: 'Above default (Jina score)' },
        { message_id: 'b', cross_encoder_score: 0.35, content: 'Below default (Jina score)' }
      ];

      const filtered = filterByConfidence(results);

      expect(filtered.results).toHaveLength(1);
      expect(filtered.results[0].message_id).toBe('a');
    });

    it('should accept custom threshold parameter', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.82, content: 'High' },
        { message_id: 'b', cross_encoder_score: 0.75, content: 'Medium' },
        { message_id: 'c', cross_encoder_score: 0.68, content: 'Low' }
      ];

      // Test with threshold 0.75
      const filtered75 = filterByConfidence(results, 0.75);
      expect(filtered75.results).toHaveLength(2);

      // Test with threshold 0.80
      const filtered80 = filterByConfidence(results, 0.80);
      expect(filtered80.results).toHaveLength(1);
    });

    it('should fallback to weighted_score when cross_encoder_score missing', () => {
      const results = [
        { message_id: 'a', weighted_score: 0.75, content: 'MMR score only' },
        { message_id: 'b', cross_encoder_score: 0.72, content: 'Reranked' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('success');
      expect(filtered.results).toHaveLength(2);
    });

    it('should handle mixed score types gracefully', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.85, weighted_score: 0.60, content: 'Has both' },
        { message_id: 'b', weighted_score: 0.72, content: 'MMR only' },
        { message_id: 'c', cross_encoder_score: 0.68, content: 'Reranked only' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      // Should use cross_encoder_score when available, fall back to weighted_score
      expect(filtered.results).toHaveLength(2);
      expect(filtered.results[0].message_id).toBe('a');  // 0.85
      expect(filtered.results[1].message_id).toBe('b');  // 0.72
    });

    it('should use score 0 when neither score field present', () => {
      const results = [
        { message_id: 'a', content: 'No scores' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('low_confidence');
      expect(filtered.results).toHaveLength(0);
      expect(filtered.highestScore).toBe(0);
    });

    it('should handle single result correctly', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.85, content: 'Only one' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('success');
      expect(filtered.results).toHaveLength(1);
      expect(filtered.message).toContain('1 relevant memory');
    });

    it('should handle exact threshold boundary', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.70, content: 'Exactly at threshold' },
        { message_id: 'b', cross_encoder_score: 0.6999, content: 'Just below' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.results).toHaveLength(1);
      expect(filtered.results[0].message_id).toBe('a');
    });
  });

  describe('Suggestion Generation', () => {
    it('should generate suggestions on low_confidence status', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.65, content: 'Low' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('low_confidence');
      expect(filtered.suggestions).toBeDefined();
      expect(filtered.suggestions.length).toBeGreaterThan(0);
      expect(filtered.suggestions.some(s => s.includes('specific'))).toBe(true);
    });

    it('should not include suggestions on success status', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.85, content: 'High' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('success');
      expect(filtered.suggestions).toBeUndefined();
    });

    it('should mention near-miss in suggestions when close to threshold', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.68, content: 'Close' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.suggestions.some(s => s.includes('close'))).toBe(true);
      expect(filtered.suggestions.some(s => s.includes('0.68'))).toBe(true);
    });
  });

  describe('Configuration', () => {
    it('should return current config', () => {
      const config = getConfig();

      expect(config).toBeDefined();
      expect(config.defaultThreshold).toBe(0.40); // Jina cross-encoder threshold
      expect(config.debugMode).toBeDefined();
    });

    it('should allow config updates', () => {
      updateConfig({ defaultThreshold: 0.75, debugMode: true });

      const config = getConfig();
      expect(config.defaultThreshold).toBe(0.75);
      expect(config.debugMode).toBe(true);
    });

    it('should use updated default threshold', () => {
      updateConfig({ defaultThreshold: 0.80 });

      const results = [
        { message_id: 'a', cross_encoder_score: 0.75, content: 'Medium' }
      ];

      // Should use default 0.80 threshold
      const filtered = filterByConfidence(results);

      expect(filtered.status).toBe('low_confidence');
      expect(filtered.results).toHaveLength(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very high scores correctly', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.99, content: 'Nearly perfect' },
        { message_id: 'b', cross_encoder_score: 1.0, content: 'Perfect match' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('success');
      expect(filtered.results).toHaveLength(2);
      expect(filtered.highestScore).toBe(1.0);
    });

    it('should handle very low scores correctly', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 0.01, content: 'Very low' },
        { message_id: 'b', cross_encoder_score: 0.05, content: 'Also low' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('low_confidence');
      expect(filtered.highestScore).toBe(0.05);
    });

    it('should handle negative scores gracefully', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: -0.5, content: 'Negative' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('low_confidence');
      expect(filtered.highestScore).toBe(-0.5);
    });

    it('should handle scores above 1.0', () => {
      const results = [
        { message_id: 'a', cross_encoder_score: 1.5, content: 'Above range' }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('success');
      expect(filtered.highestScore).toBe(1.5);
    });

    it('should handle large result sets efficiently', () => {
      const results = Array.from({ length: 100 }, (_, i) => ({
        message_id: `msg_${i}`,
        cross_encoder_score: 0.65 + (i / 100) * 0.35,  // Scores from 0.65 to 1.0
        content: `Message ${i}`
      }));

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('success');
      expect(filtered.results.length).toBeGreaterThan(0);
      expect(filtered.results.length).toBeLessThan(results.length);
    });
  });

  describe('Integration Compatibility', () => {
    it('should preserve all original fields in filtered results', () => {
      const results = [
        {
          message_id: 'abc123',
          cross_encoder_score: 0.85,
          weighted_score: 0.72,
          content: 'Test content',
          timestamp: '2024-01-01T00:00:00Z',
          platform: 'chatgpt',
          source: 'conversation',
          custom_field: 'custom_value'
        }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.results[0].message_id).toBe('abc123');
      expect(filtered.results[0].content).toBe('Test content');
      expect(filtered.results[0].timestamp).toBe('2024-01-01T00:00:00Z');
      expect(filtered.results[0].platform).toBe('chatgpt');
      expect(filtered.results[0].custom_field).toBe('custom_value');
    });

    it('should work with background.js result format', () => {
      // Simulates actual format from MMR + reranker
      const results = [
        {
          message_id: 'msg1',
          id: 'msg1',
          content: 'User asked about Jennifer',
          msg_timestamp: 1234567890000,
          timestamp: 1234567890000,
          source: 'chatgpt',
          platform: 'chatgpt',
          distance: 0.15,
          weighted_score: 0.72,
          cross_encoder_score: 0.85
        }
      ];

      const filtered = filterByConfidence(results, 0.70);

      expect(filtered.status).toBe('success');
      expect(filtered.results[0].message_id).toBe('msg1');
    });
  });
});
