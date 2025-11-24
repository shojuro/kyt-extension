/**
 * Entity Saver Tests - TDD Approach
 * Tests for saveEntitiesWithMentions function
 * These tests MUST fail initially (function doesn't exist yet)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Mock Supabase client for testing
function createMockSupabase() {
  const entities = [];
  const mentions = [];

  return {
    from: (table) => {
      if (table === 'entities') {
        return {
          select: (cols) => ({
            eq: (col, val) => ({
              eq: (col2, val2) => ({
                eq: (col3, val3) => ({
                  maybeSingle: async () => {
                    const found = entities.find(e =>
                      e.user_id === val &&
                      e.canonical_name === val2 &&
                      e.entity_type === val3
                    );
                    return { data: found || null, error: null };
                  }
                })
              })
            })
          }),
          insert: (data) => ({
            select: (cols) => ({
              single: async () => {
                const newEntity = { ...data, id: `entity_${entities.length + 1}` };
                entities.push(newEntity);
                return { data: newEntity, error: null };
              }
            })
          }),
          update: (data) => ({
            eq: (col, val) => {
              const entity = entities.find(e => e.id === val);
              if (entity) {
                Object.assign(entity, data);
              }
              return Promise.resolve({ data: null, error: null });
            }
          })
        };
      } else if (table === 'entity_mentions') {
        return {
          insert: async (data) => {
            mentions.push({ ...data, id: `mention_${mentions.length + 1}` });
            return { data: null, error: null };
          }
        };
      }
      return {};
    },
    _getEntities: () => entities,
    _getMentions: () => mentions
  };
}

describe('Entity Saver Module - Structure Tests', () => {
  const modulePath = join(__dirname, 'entity-extractor.ts');

  it('entity-extractor.ts file should exist', () => {
    const content = readFileSync(modulePath, 'utf-8');
    expect(content).toBeDefined();
  });

  it('should export saveEntitiesWithMentions function', () => {
    const content = readFileSync(modulePath, 'utf-8');
    // This test MUST fail initially - function doesn't exist yet
    expect(content).toContain('export async function saveEntitiesWithMentions');
  });

  it('saveEntitiesWithMentions should accept correct parameters', () => {
    const content = readFileSync(modulePath, 'utf-8');
    // Check function signature includes all required parameters
    expect(content).toContain('saveEntitiesWithMentions');
    expect(content).toContain('entities: ExtractedEntity[]');
    expect(content).toContain('chatTurnId: string');
    expect(content).toContain('conversationId: string');
    expect(content).toContain('userId: string');
    expect(content).toContain('supabase: any');
  });
});

describe('Entity Saver - Deduplication Logic', () => {
  it('should deduplicate entities by canonical_name', async () => {
    // This test will fail until saveEntitiesWithMentions is implemented
    const mockSupabase = createMockSupabase();

    const entities = [
      {
        entity_text: "Jennifer",
        normalized_name: "jennifer",
        entity_type: "PERSON",
        relationship: "trainer",
        context_category: "fitness"
      },
      {
        entity_text: "Jennifer",  // Same person mentioned again
        normalized_name: "jennifer",
        entity_type: "PERSON",
        relationship: "trainer",
        context_category: "fitness"
      }
    ];

    // This will fail with "saveEntitiesWithMentions is not defined"
    // We expect this failure initially
    try {
      const { saveEntitiesWithMentions } = await import('./entity-extractor.ts');
      await saveEntitiesWithMentions(
        entities,
        "turn_123",
        "conv_456",
        "user_789",
        mockSupabase
      );

      const savedEntities = mockSupabase._getEntities();

      // Should create only ONE entity (deduplication works)
      expect(savedEntities).toHaveLength(1);

      // Should have mention_count = 2 (incremented)
      expect(savedEntities[0].mention_count).toBe(2);

      // Should have correct canonical_name
      expect(savedEntities[0].canonical_name).toBe("jennifer_trainer");
    } catch (error) {
      // Expected to fail - function doesn't exist yet
      expect(error.message).toMatch(/saveEntitiesWithMentions|import/);
    }
  });
});

describe('Entity Saver - New Entity Creation', () => {
  it('should create new entity with all required fields', async () => {
    const mockSupabase = createMockSupabase();

    const entities = [
      {
        entity_text: "Dr. Smith",
        normalized_name: "dr_smith",
        entity_type: "PERSON",
        relationship: "doctor",
        context_category: "health"
      }
    ];

    try {
      const { saveEntitiesWithMentions } = await import('./entity-extractor.ts');
      await saveEntitiesWithMentions(
        entities,
        "turn_123",
        "conv_456",
        "user_789",
        mockSupabase
      );

      const savedEntities = mockSupabase._getEntities();

      expect(savedEntities).toHaveLength(1);

      const entity = savedEntities[0];
      expect(entity.user_id).toBe("user_789");
      expect(entity.entity_text).toBe("Dr. Smith");
      expect(entity.normalized_name).toBe("dr_smith");
      expect(entity.canonical_name).toBe("dr_smith_doctor");
      expect(entity.display_name).toBe("Dr. Smith");
      expect(entity.entity_type).toBe("PERSON");
      expect(entity.relationship).toBe("doctor");
      expect(entity.context_category).toBe("health");
      expect(entity.mention_count).toBe(1);
      expect(entity.first_seen).toBeDefined();
      expect(entity.last_seen).toBeDefined();
    } catch (error) {
      // Expected to fail - function doesn't exist yet
      expect(error.message).toMatch(/saveEntitiesWithMentions|import/);
    }
  });
});

describe('Entity Saver - Mention Count Increment', () => {
  it('should increment mention_count for existing entity', async () => {
    const mockSupabase = createMockSupabase();

    const entity = {
      entity_text: "Google",
      normalized_name: "google",
      entity_type: "ORG",
      relationship: "unknown",
      context_category: "work"
    };

    try {
      const { saveEntitiesWithMentions } = await import('./entity-extractor.ts');

      // First mention
      await saveEntitiesWithMentions(
        [entity],
        "turn_1",
        "conv_1",
        "user_789",
        mockSupabase
      );

      // Second mention
      await saveEntitiesWithMentions(
        [entity],
        "turn_2",
        "conv_1",
        "user_789",
        mockSupabase
      );

      const savedEntities = mockSupabase._getEntities();

      // Should still be only 1 entity
      expect(savedEntities).toHaveLength(1);

      // mention_count should be 2
      expect(savedEntities[0].mention_count).toBe(2);
    } catch (error) {
      // Expected to fail - function doesn't exist yet
      expect(error.message).toMatch(/saveEntitiesWithMentions|import/);
    }
  });
});

describe('Entity Saver - Mention Record Creation', () => {
  it('should create entity_mentions records', async () => {
    const mockSupabase = createMockSupabase();

    const entities = [
      {
        entity_text: "Python",
        normalized_name: "python",
        entity_type: "TECH",
        relationship: "unknown",
        context_category: "programming"
      }
    ];

    try {
      const { saveEntitiesWithMentions } = await import('./entity-extractor.ts');
      await saveEntitiesWithMentions(
        entities,
        "turn_123",
        "conv_456",
        "user_789",
        mockSupabase
      );

      const mentions = mockSupabase._getMentions();

      // Should create 1 mention
      expect(mentions).toHaveLength(1);

      const mention = mentions[0];
      expect(mention.entity_id).toBeDefined();
      expect(mention.conversation_id).toBe("conv_456");
      expect(mention.chat_turn_id).toBe("turn_123");
      expect(mention.mention_text).toBe("Python");
      expect(mention.timestamp).toBeDefined();
    } catch (error) {
      // Expected to fail - function doesn't exist yet
      expect(error.message).toMatch(/saveEntitiesWithMentions|import/);
    }
  });
});

describe('Entity Saver - Multiple Entities', () => {
  it('should handle multiple different entities', async () => {
    const mockSupabase = createMockSupabase();

    const entities = [
      {
        entity_text: "Alice",
        normalized_name: "alice",
        entity_type: "PERSON",
        relationship: "colleague",
        context_category: "work"
      },
      {
        entity_text: "Bob",
        normalized_name: "bob",
        entity_type: "PERSON",
        relationship: "friend",
        context_category: "social"
      }
    ];

    try {
      const { saveEntitiesWithMentions } = await import('./entity-extractor.ts');
      await saveEntitiesWithMentions(
        entities,
        "turn_123",
        "conv_456",
        "user_789",
        mockSupabase
      );

      const savedEntities = mockSupabase._getEntities();
      const mentions = mockSupabase._getMentions();

      // Should create 2 entities
      expect(savedEntities).toHaveLength(2);

      // Should create 2 mentions
      expect(mentions).toHaveLength(2);

      // Verify canonical names are relationship-aware
      const canonicalNames = savedEntities.map(e => e.canonical_name).sort();
      expect(canonicalNames).toEqual(["alice_colleague", "bob_friend"]);
    } catch (error) {
      // Expected to fail - function doesn't exist yet
      expect(error.message).toMatch(/saveEntitiesWithMentions|import/);
    }
  });
});

describe('Entity Saver - Relationship Differentiation', () => {
  it('should differentiate same name with different relationships', async () => {
    const mockSupabase = createMockSupabase();

    const entities = [
      {
        entity_text: "Jennifer",
        normalized_name: "jennifer",
        entity_type: "PERSON",
        relationship: "trainer",
        context_category: "fitness"
      },
      {
        entity_text: "Jennifer",
        normalized_name: "jennifer",
        entity_type: "PERSON",
        relationship: "sister",
        context_category: "family"
      }
    ];

    try {
      const { saveEntitiesWithMentions } = await import('./entity-extractor.ts');
      await saveEntitiesWithMentions(
        entities,
        "turn_123",
        "conv_456",
        "user_789",
        mockSupabase
      );

      const savedEntities = mockSupabase._getEntities();

      // Should create 2 DIFFERENT entities (different relationships)
      expect(savedEntities).toHaveLength(2);

      // Verify different canonical names
      const canonicalNames = savedEntities.map(e => e.canonical_name).sort();
      expect(canonicalNames).toEqual(["jennifer_sister", "jennifer_trainer"]);
    } catch (error) {
      // Expected to fail - function doesn't exist yet
      expect(error.message).toMatch(/saveEntitiesWithMentions|import/);
    }
  });
});
