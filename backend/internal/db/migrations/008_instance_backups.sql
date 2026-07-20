CREATE TABLE IF NOT EXISTS instance_backups (
    id uuid PRIMARY KEY,
    instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE RESTRICT,
    host_id uuid NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
    template_version_id uuid NOT NULL REFERENCES template_versions(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
    status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','ready','restoring','deleting','failed')),
    remote_path text NOT NULL CHECK (remote_path <> ''),
    size_bytes bigint NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    sha256 text NOT NULL DEFAULT '' CHECK (sha256 = '' OR sha256 ~ '^[0-9a-f]{64}$'),
    error_message text NOT NULL DEFAULT '',
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instance_backups_instance_idx ON instance_backups (instance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS instance_backups_host_idx ON instance_backups (host_id, status);
CREATE INDEX IF NOT EXISTS tasks_active_backup_idx ON tasks ((payload->>'backupId'))
    WHERE status IN ('queued', 'running') AND payload ? 'backupId';
