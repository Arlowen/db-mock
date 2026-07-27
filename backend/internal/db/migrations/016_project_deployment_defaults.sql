ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS default_environment text,
    ADD COLUMN IF NOT EXISTS default_expiry_days integer,
    ADD COLUMN IF NOT EXISTS default_labels jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_default_environment_check,
    ADD CONSTRAINT projects_default_environment_check
        CHECK (default_environment IS NULL OR default_environment IN ('development', 'testing', 'staging', 'production')),
    DROP CONSTRAINT IF EXISTS projects_default_expiry_days_check,
    ADD CONSTRAINT projects_default_expiry_days_check
        CHECK (default_expiry_days IS NULL OR default_expiry_days BETWEEN 0 AND 365),
    DROP CONSTRAINT IF EXISTS projects_default_labels_check,
    ADD CONSTRAINT projects_default_labels_check
        CHECK (jsonb_typeof(default_labels) = 'object');
