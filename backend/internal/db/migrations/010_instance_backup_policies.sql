ALTER TABLE instance_backups
    ADD COLUMN IF NOT EXISTS creation_type text NOT NULL DEFAULT 'manual';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'instance_backups_creation_type_check'
          AND conrelid = 'instance_backups'::regclass
    ) THEN
        ALTER TABLE instance_backups
            ADD CONSTRAINT instance_backups_creation_type_check
            CHECK (creation_type IN ('manual','scheduled'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS instance_backup_policies (
    instance_id uuid PRIMARY KEY REFERENCES instances(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    frequency text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily','weekly')),
    weekday smallint NOT NULL DEFAULT 0 CHECK (weekday BETWEEN 0 AND 6),
    hour smallint NOT NULL DEFAULT 2 CHECK (hour BETWEEN 0 AND 23),
    minute smallint NOT NULL DEFAULT 0 CHECK (minute BETWEEN 0 AND 59),
    timezone text NOT NULL DEFAULT 'UTC' CHECK (char_length(btrim(timezone)) BETWEEN 1 AND 128),
    retention_count integer NOT NULL DEFAULT 7 CHECK (retention_count BETWEEN 1 AND 100),
    next_run_at timestamptz,
    last_run_at timestamptz,
    last_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    last_status text NOT NULL DEFAULT '' CHECK (last_status IN ('','queued','running','succeeded','failed','canceled')),
    last_error text NOT NULL DEFAULT '',
    configured_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((enabled AND next_run_at IS NOT NULL) OR NOT enabled)
);

CREATE INDEX IF NOT EXISTS instance_backup_policies_due_idx ON instance_backup_policies (next_run_at)
    WHERE enabled;
