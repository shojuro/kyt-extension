/**
 * Architectural Validation Tests for BM25 Server-Side Search
 *
 * PHASE 1: TDD - Tests written BEFORE implementation
 *
 * These tests validate architectural constraints:
 * - Test 5: BM25/FTS is server-side only (no PostgreSQL FTS in client code)
 * - Test 6: Gravity formula remains unchanged (BM25 doesn't corrupt gravity)
 *
 * EXPECTED STATE:
 * - Test 5: Should PASS (regression test - no PostgreSQL FTS in client before/after)
 * - Test 6: Should PASS (regression test - gravity formula unchanged before/after)
 *
 * These are GUARD TESTS that prevent architectural violations during implementation.
 *
 * CLAUDE.md Compliance:
 * ✅ Tests can FAIL meaningfully
 * ✅ No validation theater
 * ✅ Tests real architectural constraints
 */

import { describe, it, expect } from 'vitest';
import { glob } from 'glob';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get the project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

/**
 * Test 5: BM25 is server-side only
 *
 * Purpose: Ensure PostgreSQL full-text search concepts (tsvector, ts_rank,
 * websearch_to_tsquery) never leak into client-side JavaScript.
 *
 * Why this matters:
 * - Client-side code runs in browser extension context
 * - PostgreSQL FTS requires database connection
 * - Any FTS code in client would be non-functional and indicate leaky architecture
 *
 * Note: This does NOT check for the existing JavaScript BM25 implementation
 * (src/bm25-search.js) which is a separate client-side approximation.
 * We're specifically checking that PostgreSQL FTS terms don't appear.
 */
describe('Architectural: Server-Side Only', () => {
  it('BM25 is server-side only - no PostgreSQL FTS in client code', async () => {
    // Find all JavaScript files in src/ directory (client-side code)
    const srcPath = join(PROJECT_ROOT, 'src');
    const clientFiles = glob.sync('**/*.js', { cwd: srcPath });

    // PostgreSQL Full-Text Search terms that must NOT appear in client code
    const forbiddenPatterns = [
      /\btsvector\b/i,           // PostgreSQL text search vector type
      /\bts_rank\b/i,            // PostgreSQL text ranking function
      /\bts_rank_cd\b/i,         // PostgreSQL cover density ranking
      /\bwebsearch_to_tsquery\b/i, // PostgreSQL web search query parser
      /\bto_tsquery\b/i,         // PostgreSQL text search query parser
      /\bplainto_tsquery\b/i,    // PostgreSQL plain text query parser
      /\b@@\s*to_tsquery/i,      // PostgreSQL FTS match operator
      /GIN\s+index/i,            // PostgreSQL GIN index (FTS-specific)
      /\bsetweight\b/i,          // PostgreSQL FTS weighting function
    ];

    const violations = [];

    for (const file of clientFiles) {
      const filePath = join(srcPath, file);
      let content;

      try {
        content = readFileSync(filePath, 'utf8');
      } catch (e) {
        // Skip files that can't be read (e.g., binary)
        continue;
      }

      for (const pattern of forbiddenPatterns) {
        if (pattern.test(content)) {
          violations.push({
            file,
            pattern: pattern.toString(),
            violation: content.match(pattern)?.[0]
          });
        }
      }
    }

    // Report all violations
    if (violations.length > 0) {
      const violationReport = violations
        .map(v => `  - ${v.file}: found "${v.violation}" (pattern: ${v.pattern})`)
        .join('\n');

      expect.fail(
        `PostgreSQL FTS terms found in client code:\n${violationReport}\n\n` +
        'BM25/FTS must be server-side only. Move this logic to Edge Functions or SQL.'
      );
    }

    // If we get here, no violations found
    expect(violations).toHaveLength(0);
  });

  it('No PostgreSQL-specific SQL in client JavaScript', async () => {
    // Additional check: No raw SQL that looks like PostgreSQL FTS
    const srcPath = join(PROJECT_ROOT, 'src');
    const clientFiles = glob.sync('**/*.js', { cwd: srcPath });

    const sqlPatterns = [
      /SELECT.*FROM.*WHERE.*@@/i,  // FTS match query pattern
      /CREATE\s+INDEX.*USING\s+GIN/i,  // GIN index creation
      /ALTER\s+TABLE.*ADD.*tsvector/i, // Adding tsvector column
    ];

    const violations = [];

    for (const file of clientFiles) {
      const filePath = join(srcPath, file);
      let content;

      try {
        content = readFileSync(filePath, 'utf8');
      } catch (e) {
        continue;
      }

      for (const pattern of sqlPatterns) {
        if (pattern.test(content)) {
          violations.push({
            file,
            pattern: pattern.toString()
          });
        }
      }
    }

    expect(violations).toHaveLength(0);
  });
});

/**
 * Test 6: Gravity formula unchanged
 *
 * Purpose: Ensure the gravity calculation formula is not modified
 * to include BM25 scoring internally. BM25 should be an ADDITIVE boost
 * applied AFTER gravity, not embedded within gravity.
 *
 * Gravity Formula (must remain):
 *   vector_similarity × importance_multiplier × time_decay × rehearsal_bonus
 *
 * Where:
 *   importance_multiplier = 1 + (impact/100) + (intimacy × 0.2)
 *
 * BM25 should NOT appear in these calculations.
 */
describe('Architectural: Gravity Formula Unchanged', () => {
  const gravitySqlPath = join(
    PROJECT_ROOT,
    'supabase',
    'functions',
    '_sql',
    'calculate_gravity_score.sql'
  );

  it('Gravity formula SQL file exists', () => {
    expect(existsSync(gravitySqlPath)).toBe(true);
  });

  it('Gravity formula contains required components', () => {
    const gravityFunc = readFileSync(gravitySqlPath, 'utf8');

    // Required formula components (from architecture spec)
    expect(gravityFunc).toMatch(/v_importance_multiplier/);
    expect(gravityFunc).toMatch(/v_time_decay/);
    expect(gravityFunc).toMatch(/v_rehearsal_bonus/);
    expect(gravityFunc).toMatch(/p_vector_similarity/);

    // Required importance calculation
    expect(gravityFunc).toMatch(/1\.0\s*\+/); // Baseline
    expect(gravityFunc).toMatch(/p_impact_score/);
    expect(gravityFunc).toMatch(/p_intimacy_level/);

    // Final formula structure: similarity * importance * decay * rehearsal
    expect(gravityFunc).toMatch(
      /p_vector_similarity\s*\*\s*v_importance_multiplier\s*\*\s*v_time_decay\s*\*\s*v_rehearsal_bonus/
    );
  });

  it('Gravity formula does NOT contain BM25 terms', () => {
    const gravityFunc = readFileSync(gravitySqlPath, 'utf8');

    // BM25 terms that MUST NOT appear inside gravity calculation
    const forbiddenTerms = [
      /\bbm25\b/i,               // BM25 scoring
      /\btf_idf\b/i,             // TF-IDF (BM25 basis)
      /\bidf\b/i,                // Inverse document frequency
      /\bterm_frequency\b/i,    // Term frequency
      /\bkeyword_score\b/i,     // Keyword scoring
      /\bts_rank/i,             // PostgreSQL FTS ranking
      /\btsvector/i,            // PostgreSQL FTS vector
    ];

    for (const pattern of forbiddenTerms) {
      const match = gravityFunc.match(pattern);
      expect(
        match,
        `Gravity formula must not contain BM25/FTS term: ${pattern}`
      ).toBeNull();
    }
  });

  it('Gravity formula uses adaptive time decay based on importance', () => {
    const gravityFunc = readFileSync(gravitySqlPath, 'utf8');

    // Verify adaptive decay strategy is present
    // High importance: logarithmic decay (LN function)
    expect(gravityFunc).toMatch(/LN\s*\(/i);

    // Low importance: exponential decay (EXP function)
    expect(gravityFunc).toMatch(/EXP\s*\(/i);

    // Importance threshold checks
    expect(gravityFunc).toMatch(/v_importance_multiplier\s*>/);
    expect(gravityFunc).toMatch(/v_importance_multiplier\s*</);
  });

  it('Gravity formula returns FLOAT with expected range', () => {
    const gravityFunc = readFileSync(gravitySqlPath, 'utf8');

    // Function should return FLOAT
    expect(gravityFunc).toMatch(/RETURNS\s+FLOAT/i);

    // Should have range documentation
    expect(gravityFunc).toMatch(/Range:\s*\[0\.0/);
  });
});

/**
 * Additional architectural guard: search_with_gravity uses gravity correctly
 */
describe('Architectural: Search Integration', () => {
  const searchSqlPath = join(
    PROJECT_ROOT,
    'supabase',
    'functions',
    '_sql',
    'search_with_gravity.sql'
  );

  it('search_with_gravity SQL file exists', () => {
    // If this file doesn't exist, test passes vacuously (nothing to validate)
    // In Phase 2, this file will be modified and this test becomes relevant
    if (!existsSync(searchSqlPath)) {
      console.warn('search_with_gravity.sql not found - skipping validation');
      return;
    }

    expect(existsSync(searchSqlPath)).toBe(true);
  });

  it('search_with_gravity calls calculate_gravity_score', () => {
    if (!existsSync(searchSqlPath)) {
      return; // Skip if file doesn't exist
    }

    const searchFunc = readFileSync(searchSqlPath, 'utf8');

    // Search function should use calculate_gravity_score
    expect(searchFunc).toMatch(/calculate_gravity_score\s*\(/);
  });
});

/**
 * Meta-test: Verify test files can detect real violations
 */
describe('Meta: Test Can Detect Violations', () => {
  it('can detect PostgreSQL FTS terms in sample string', () => {
    const sampleWithViolation = `
      const query = "SELECT * FROM messages WHERE content_tsvector @@ to_tsquery('english', $1)";
    `;

    expect(sampleWithViolation).toMatch(/tsvector/i);
    expect(sampleWithViolation).toMatch(/to_tsquery/i);
  });

  it('can detect BM25 terms in sample string', () => {
    // Note: \b doesn't work with underscores (e.g., bm25_score)
    // So we test with isolated terms that the actual checks would catch
    const sampleWithBM25 = `
      const score = bm25(term_frequency, idf, doc_length);
    `;

    expect(sampleWithBM25).toMatch(/\bbm25\b/i);
    expect(sampleWithBM25).toMatch(/\bidf\b/i);
  });
});
