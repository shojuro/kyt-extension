-- Dev Knowledge Gaps: Decision extraction infrastructure
-- Gaps 2+5: supersession tracking + audit trail
--
-- Gap 2: superseded_by column on entities — tracks when decisions change
-- Gap 5: memory_audit_log — records merges, supersessions, pruning

-- ── Gap 2: Supersession + Decision Metadata ─────────────────

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES entities(id),
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Index for filtering out superseded entities in retrieval
CREATE INDEX IF NOT EXISTS idx_entities_active
  ON entities(user_id, entity_type)
  WHERE superseded_by IS NULL;

-- Index for decision entity lookups
CREATE INDEX IF NOT EXISTS idx_entities_decisions
  ON entities(user_id)
  WHERE entity_type IN ('TECH', 'CONCEPT') AND (metadata->>'decision') IS NOT NULL;

COMMENT ON COLUMN entities.superseded_by IS
  'When a decision/fact is replaced by a newer one, points to the replacement entity. NULL = current/active.';

COMMENT ON COLUMN entities.metadata IS
  'Structured data for enriched entity types. For decisions: {decision, value, rationale, alternatives[], constraints[], context}. For metrics: {metric, value, unit, context}.';

-- ── Gap 5: Audit Trail ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('supersede', 'merge', 'prune', 'create_decision', 'update_decision')),
  entity_id UUID REFERENCES entities(id),
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE memory_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their audit logs"
  ON memory_audit_log FOR ALL USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_audit_log_user_date
  ON memory_audit_log(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON memory_audit_log(entity_id)
  WHERE entity_id IS NOT NULL;

COMMENT ON TABLE memory_audit_log IS
  'Tracks entity lifecycle events: supersessions, merges, pruning. Enables debugging "why did K.Y.T. forget X."';
