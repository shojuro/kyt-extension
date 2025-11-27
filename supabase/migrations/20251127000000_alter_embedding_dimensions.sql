-- Migration: Alter embedding column to match Qwen3-Embedding-8B output (4096 dimensions)
-- Previously: vector(1536) for OpenAI text-embedding-3-small
-- Now: vector(4096) for Qwen3-Embedding-8B via HuggingFace Router

-- Update chat_turns embedding column
ALTER TABLE chat_turns
  ALTER COLUMN embedding TYPE vector(4096);

-- Update entities embedding column if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'entities' AND column_name = 'embedding'
  ) THEN
    ALTER TABLE entities ALTER COLUMN embedding TYPE vector(4096);
  END IF;
END $$;

-- Note: Existing data with 1536 dimensions will need to be re-embedded
-- or the old records cleared before inserting new 4096-dimension embeddings
