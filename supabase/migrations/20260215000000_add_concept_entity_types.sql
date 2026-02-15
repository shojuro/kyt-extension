-- Add CONCEPT, ANALOGY, THEME entity types for GraphRAG concept extraction
-- These allow the entity system to capture abstract ideas and metaphors,
-- not just named entities like people and organizations.

ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_entity_type_check;
ALTER TABLE entities ADD CONSTRAINT entities_entity_type_check
  CHECK (entity_type IN (
    'PERSON', 'ORG', 'LOCATION', 'PROJECT', 'TECH', 'MISC',
    'CONCEPT', 'ANALOGY', 'THEME'
  ));
