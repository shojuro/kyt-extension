-- Add metadata JSONB column to chat_turns for structured provenance storage.
-- Replaces inline [RESEARCH NOTE] content wrapping with queryable metadata.

ALTER TABLE chat_turns ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_chat_turns_metadata_gin
  ON chat_turns USING GIN (metadata);

-- Backfill existing NotebookLM rows: extract notebook title, strip provenance wrapper
UPDATE chat_turns
SET
  metadata = jsonb_build_object(
    'notebook_title', substring(content FROM '\[RESEARCH NOTE — from NotebookLM notebook ''([^'']+)''\]'),
    'migrated', true
  ),
  content = regexp_replace(
    regexp_replace(content, E'^\\[RESEARCH NOTE[^\\]]*\\]\\n', ''),
    E'\\n\\[END RESEARCH NOTE\\]$', ''
  )
WHERE platform = 'notebooklm'
  AND content LIKE '[RESEARCH NOTE%';
