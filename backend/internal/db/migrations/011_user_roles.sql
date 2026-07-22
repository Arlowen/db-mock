ALTER TABLE users
    ADD COLUMN IF NOT EXISTS role text;

-- Accounts created before RBAC existed keep their previous full access. New
-- accounts are explicitly assigned a role by the API and default to viewer as
-- a defense-in-depth fallback for direct inserts.
UPDATE users SET role = 'admin' WHERE role IS NULL;

ALTER TABLE users
    ALTER COLUMN role SET NOT NULL,
    ALTER COLUMN role SET DEFAULT 'viewer';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_role_check'
          AND conrelid = 'users'::regclass
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_role_check
            CHECK (role IN ('admin','operator','viewer'));
    END IF;
END $$;
