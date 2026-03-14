-- Migration: Vault PIN gate
--
-- Adds bcrypt-hashed PIN protection for vault projects.
-- - vault_pin_hash column on projects table
-- - create_project_rpc: creates projects with optional PIN (required for vaults)
-- - verify_vault_pin: verifies PIN against stored hash

SET search_path TO public, extensions;

-- Enable pgcrypto for bcrypt
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Add PIN hash column to projects
ALTER TABLE projects ADD COLUMN IF NOT EXISTS vault_pin_hash TEXT;

-- ============================================================================
-- create_project_rpc: SECURITY DEFINER to bypass RLS
-- ============================================================================
CREATE OR REPLACE FUNCTION create_project_rpc(
    p_user_id UUID,
    p_name TEXT,
    p_description TEXT DEFAULT NULL,
    p_is_vault BOOLEAN DEFAULT FALSE,
    p_pin TEXT DEFAULT NULL
)
RETURNS TABLE (id UUID, name TEXT, description TEXT, is_vault BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF p_is_vault AND (p_pin IS NULL OR length(trim(p_pin)) < 4) THEN
        RAISE EXCEPTION 'Vault projects require a PIN of at least 4 characters';
    END IF;

    RETURN QUERY
    INSERT INTO projects (user_id, name, description, is_vault, vault_pin_hash)
    VALUES (
        p_user_id, p_name, p_description, p_is_vault,
        CASE WHEN p_is_vault AND p_pin IS NOT NULL
            THEN crypt(p_pin, gen_salt('bf'))
            ELSE NULL
        END
    )
    RETURNING projects.id, projects.name, projects.description, projects.is_vault, projects.created_at;
END;
$$;

-- ============================================================================
-- verify_vault_pin: SECURITY DEFINER to read hash without exposing it
-- ============================================================================
CREATE OR REPLACE FUNCTION verify_vault_pin(
    p_project_id UUID,
    p_user_id UUID,
    p_pin TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_hash TEXT;
BEGIN
    SELECT vault_pin_hash INTO v_hash
    FROM projects
    WHERE projects.id = p_project_id
      AND projects.user_id = p_user_id
      AND projects.is_vault = TRUE;

    IF v_hash IS NULL THEN
        RETURN FALSE;
    END IF;

    RETURN v_hash = crypt(p_pin, v_hash);
END;
$$;

-- ============================================================================
-- Grants
-- ============================================================================
GRANT EXECUTE ON FUNCTION create_project_rpc(UUID, TEXT, TEXT, BOOLEAN, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION create_project_rpc(UUID, TEXT, TEXT, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION verify_vault_pin(UUID, UUID, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION verify_vault_pin(UUID, UUID, TEXT) TO authenticated;
