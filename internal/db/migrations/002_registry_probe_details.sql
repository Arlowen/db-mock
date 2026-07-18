ALTER TABLE registries
    ADD COLUMN IF NOT EXISTS status_message text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS status_code integer;
