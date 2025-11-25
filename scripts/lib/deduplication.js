/**
 * Deduplication Checker
 *
 * Detects both exact and near-duplicate text using:
 * - MD5 hashing for exact duplicates (fast)
 * - Levenshtein similarity for fuzzy duplicates (slower, limited scope)
 */

import crypto from 'crypto';

export class DeduplicationChecker {
  constructor(options = {}) {
    this.fuzzyThreshold = options.fuzzyThreshold || 0.90;  // 90% similarity = duplicate
    this.fuzzyCacheSize = options.fuzzyCacheSize || 1000;  // Check last 1000 texts

    // Storage
    this.exactHashes = new Set();
    this.fuzzyCache = [];  // Array of normalized texts for fuzzy matching

    // Stats
    this.totalChecked = 0;
    this.exactDuplicates = 0;
    this.fuzzyDuplicates = 0;
  }

  /**
   * Check if text is a duplicate
   * @param {string} text - Text to check
   * @returns {boolean} - True if duplicate
   */
  isDuplicate(text) {
    this.totalChecked++;

    // Normalize text
    const normalized = this._normalize(text);

    // Level 1: Exact hash check (fast - O(1))
    const hash = this._hash(normalized);
    if (this.exactHashes.has(hash)) {
      this.exactDuplicates++;
      return true;
    }

    // Level 2: Fuzzy matching (slower - O(n))
    // Only check recent entries (bounded by fuzzyCacheSize)
    for (const cachedText of this.fuzzyCache.slice(-this.fuzzyCacheSize)) {
      const similarity = this._calculateSimilarity(normalized, cachedText);
      if (similarity >= this.fuzzyThreshold) {
        this.fuzzyDuplicates++;
        return true;
      }
    }

    // Not a duplicate - add to caches
    this.exactHashes.add(hash);
    this.fuzzyCache.push(normalized);

    // Limit fuzzy cache size
    if (this.fuzzyCache.length > this.fuzzyCacheSize) {
      this.fuzzyCache = this.fuzzyCache.slice(-this.fuzzyCacheSize);
    }

    return false;
  }

  /**
   * Get deduplication statistics
   * @returns {Object}
   */
  getStats() {
    const duplicateRate = this.totalChecked > 0
      ? ((this.exactDuplicates + this.fuzzyDuplicates) / this.totalChecked * 100).toFixed(1)
      : '0.0';

    return {
      totalChecked: this.totalChecked,
      exactDuplicates: this.exactDuplicates,
      fuzzyDuplicates: this.fuzzyDuplicates,
      totalDuplicates: this.exactDuplicates + this.fuzzyDuplicates,
      duplicateRate: `${duplicateRate}%`,
      uniqueCount: this.exactHashes.size,
      fuzzyCacheSize: this.fuzzyCache.length
    };
  }

  /**
   * Reset the checker
   */
  reset() {
    this.exactHashes.clear();
    this.fuzzyCache = [];
    this.totalChecked = 0;
    this.exactDuplicates = 0;
    this.fuzzyDuplicates = 0;
  }

  /**
   * Normalize text for comparison
   * @private
   */
  _normalize(text) {
    return text
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')  // Collapse whitespace
      .replace(/[^\w\s]/g, '');  // Remove punctuation
  }

  /**
   * Hash text for exact matching
   * @private
   */
  _hash(text) {
    return crypto
      .createHash('md5')
      .update(text)
      .digest('hex');
  }

  /**
   * Calculate similarity between two strings
   * Uses Levenshtein-based similarity (0.0 = completely different, 1.0 = identical)
   * @private
   */
  _calculateSimilarity(str1, str2) {
    // Quick checks
    if (str1 === str2) return 1.0;
    if (str1.length === 0 || str2.length === 0) return 0.0;

    // For very long strings, use a faster approximation
    if (str1.length > 500 || str2.length > 500) {
      return this._fastSimilarity(str1, str2);
    }

    // Levenshtein distance
    const distance = this._levenshteinDistance(str1, str2);
    const maxLength = Math.max(str1.length, str2.length);

    return 1.0 - (distance / maxLength);
  }

  /**
   * Fast similarity check for long strings
   * Uses character frequency comparison
   * @private
   */
  _fastSimilarity(str1, str2) {
    // Compare first 100 and last 100 characters
    const start1 = str1.substring(0, 100);
    const start2 = str2.substring(0, 100);
    const end1 = str1.substring(str1.length - 100);
    const end2 = str2.substring(str2.length - 100);

    const startSim = this._levenshteinDistance(start1, start2) / 100;
    const endSim = this._levenshteinDistance(end1, end2) / 100;

    // Length similarity
    const lengthSim = 1.0 - Math.abs(str1.length - str2.length) / Math.max(str1.length, str2.length);

    // Average similarities
    return (1 - startSim) * 0.4 + (1 - endSim) * 0.4 + lengthSim * 0.2;
  }

  /**
   * Calculate Levenshtein distance
   * @private
   */
  _levenshteinDistance(str1, str2) {
    const len1 = str1.length;
    const len2 = str2.length;

    // Create matrix
    const matrix = Array(len1 + 1).fill(null).map(() => Array(len2 + 1).fill(0));

    // Initialize first column and row
    for (let i = 0; i <= len1; i++) matrix[i][0] = i;
    for (let j = 0; j <= len2; j++) matrix[0][j] = j;

    // Fill matrix
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // deletion
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j - 1] + cost // substitution
        );
      }
    }

    return matrix[len1][len2];
  }
}
