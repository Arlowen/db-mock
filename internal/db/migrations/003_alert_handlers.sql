ALTER TABLE alerts
    ADD COLUMN IF NOT EXISTS acknowledged_by text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS resolved_by text NOT NULL DEFAULT '';
