-- Migration: set_vault_pin RPC
--
-- Allows setting or changing the PIN on an existing vault project.
-- Only works on projects where is_vault = true.

CREATE OR REPLACE FUNCTION set_vault_pin(
    p_project_id UUID,
    p_user_id UUID,
    p_pin TEXT,
    p_old_pin TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_project RECORD;
BEGIN
    -- Look up the project
    SELECT id, is_vault, vault_pin_hash
    INTO v_project
    FROM projects
    WHERE projects.id = p_project_id
      AND projects.user_id = p_user_id;

    IF v_project IS NULL THEN
        RAISE EXCEPTION 'Project not found';
    END IF;

    IF NOT v_project.is_vault THEN
        RAISE EXCEPTION 'Only vault projects can have a PIN';
    END IF;

    -- Validate new PIN
    IF p_pin IS NULL OR length(trim(p_pin)) < 4 THEN
        RAISE EXCEPTION 'PIN must be at least 4 characters';
    END IF;

    -- If project already has a PIN, require old PIN to change it
    IF v_project.vault_pin_hash IS NOT NULL THEN
        IF p_old_pin IS NULL THEN
            RAISE EXCEPTION 'Current PIN required to change an existing PIN';
        END IF;
        IF v_project.vault_pin_hash != crypt(p_old_pin, v_project.vault_pin_hash) THEN
            RAISE EXCEPTION 'Current PIN is incorrect';
        END IF;
    END IF;

    -- Set the new PIN
    UPDATE projects
    SET vault_pin_hash = crypt(p_pin, gen_salt('bf'))
    WHERE projects.id = p_project_id;

    RETURN TRUE;
END;
$$;

GRANT EXECUTE ON FUNCTION set_vault_pin(UUID, UUID, TEXT, TEXT) TO anon;
GRANT EXECUTE ON FUNCTION set_vault_pin(UUID, UUID, TEXT, TEXT) TO authenticated;
