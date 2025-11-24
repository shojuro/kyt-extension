-- Fix entity_type enum to match entity-extractor.ts expectations
-- Change from abbreviated ('PER', 'ORG', 'LOC') to full names ('PERSON', 'ORG', 'LOCATION')

-- Drop the old constraint
ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_entity_type_check;

-- Add new constraint with full entity type names
ALTER TABLE entities ADD CONSTRAINT entities_entity_type_check 
CHECK (entity_type IN ('PERSON', 'ORG', 'LOCATION', 'PROJECT', 'TECH', 'MISC'));
