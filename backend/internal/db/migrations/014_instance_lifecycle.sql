ALTER TABLE instances
    ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS owner_name text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE instances
    DROP CONSTRAINT IF EXISTS instances_purpose_length_check,
    ADD CONSTRAINT instances_purpose_length_check CHECK (char_length(purpose) <= 500),
    DROP CONSTRAINT IF EXISTS instances_owner_name_length_check,
    ADD CONSTRAINT instances_owner_name_length_check CHECK (char_length(owner_name) <= 120);

CREATE INDEX IF NOT EXISTS instances_lifecycle_due_idx
    ON instances (expires_at)
    WHERE status <> 'deleted' AND expires_at IS NOT NULL;
