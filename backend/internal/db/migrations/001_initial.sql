CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY,
    username text NOT NULL,
    display_name text NOT NULL DEFAULT '',
    locale text NOT NULL DEFAULT 'zh-CN',
    password_hash text NOT NULL,
    disabled_at timestamptz,
    last_login_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen timestamptz NOT NULL DEFAULT now(),
    ip text NOT NULL DEFAULT '',
    user_agent text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS projects (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    color text NOT NULL DEFAULT '#1677ff',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_name_lower_idx ON projects (lower(name));

CREATE TABLE IF NOT EXISTS hosts (
    id uuid PRIMARY KEY,
    project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
    name text NOT NULL,
    ssh_address text NOT NULL,
    ssh_port integer NOT NULL DEFAULT 22 CHECK (ssh_port BETWEEN 1 AND 65535),
    ssh_user text NOT NULL,
    auth_type text NOT NULL CHECK (auth_type IN ('password', 'private_key')),
    encrypted_credential text NOT NULL,
    host_key text NOT NULL DEFAULT '',
    connection_address text NOT NULL,
    data_root text NOT NULL,
    port_start integer NOT NULL DEFAULT 20000 CHECK (port_start BETWEEN 1 AND 65535),
    port_end integer NOT NULL DEFAULT 40000 CHECK (port_end BETWEEN 1 AND 65535),
    manage_docker boolean NOT NULL DEFAULT false,
    proxy_http text NOT NULL DEFAULT '',
    proxy_https text NOT NULL DEFAULT '',
    proxy_no_proxy text NOT NULL DEFAULT '',
    os text NOT NULL DEFAULT '',
    distro text NOT NULL DEFAULT '',
    architecture text NOT NULL DEFAULT '',
    docker_version text NOT NULL DEFAULT '',
    compose_version text NOT NULL DEFAULT '',
    cpu_count double precision NOT NULL DEFAULT 0,
    memory_bytes bigint NOT NULL DEFAULT 0,
    disk_total_bytes bigint NOT NULL DEFAULT 0,
    disk_free_bytes bigint NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'pending',
    status_message text NOT NULL DEFAULT '',
    maintenance boolean NOT NULL DEFAULT false,
    auto_restart_default boolean NOT NULL DEFAULT true,
    last_seen_at timestamptz,
    last_checked_at timestamptz,
    consecutive_failures integer NOT NULL DEFAULT 0,
    labels jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (port_start <= port_end)
);
CREATE UNIQUE INDEX IF NOT EXISTS hosts_name_lower_idx ON hosts (lower(name));

CREATE TABLE IF NOT EXISTS registries (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    url text NOT NULL,
    username text NOT NULL DEFAULT '',
    encrypted_password text NOT NULL DEFAULT '',
    encrypted_ca_certificate text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'unknown',
    last_tested_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS registries_name_lower_idx ON registries (lower(name));

CREATE TABLE IF NOT EXISTS templates (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE,
    name text NOT NULL,
    name_zh text NOT NULL,
    description text NOT NULL DEFAULT '',
    category text NOT NULL,
    tier text NOT NULL CHECK (tier IN ('standard', 'experimental', 'custom')),
    builtin boolean NOT NULL DEFAULT false,
    icon text NOT NULL DEFAULT '',
    risk_report jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS template_versions (
    id uuid PRIMARY KEY,
    template_id uuid NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
    version text NOT NULL,
    image_reference text NOT NULL DEFAULT '',
    architectures text[] NOT NULL DEFAULT ARRAY['amd64']::text[],
    min_cpu double precision NOT NULL,
    min_memory_bytes bigint NOT NULL,
    min_disk_bytes bigint NOT NULL,
    default_port integer NOT NULL CHECK (default_port BETWEEN 1 AND 65535),
    compose_template text NOT NULL,
    manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
    risk_report jsonb NOT NULL DEFAULT '[]'::jsonb,
    package_path text NOT NULL DEFAULT '',
    immutable boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (template_id, version)
);

CREATE TABLE IF NOT EXISTS instances (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    project_id uuid REFERENCES projects(id) ON DELETE RESTRICT,
    host_id uuid NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
    template_version_id uuid NOT NULL REFERENCES template_versions(id) ON DELETE RESTRICT,
    environment text NOT NULL DEFAULT 'development' CHECK (environment IN ('development', 'testing', 'staging', 'production')),
    labels jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'provisioning',
    status_message text NOT NULL DEFAULT '',
    desired_state text NOT NULL DEFAULT 'running' CHECK (desired_state IN ('running', 'stopped', 'deleted')),
    auto_restart boolean NOT NULL DEFAULT true,
    restart_failures integer NOT NULL DEFAULT 0,
    cpu double precision NOT NULL,
    memory_bytes bigint NOT NULL,
    reserved_disk_bytes bigint NOT NULL,
    host_port integer NOT NULL CHECK (host_port BETWEEN 1 AND 65535),
    container_port integer NOT NULL CHECK (container_port BETWEEN 1 AND 65535),
    bind_address text NOT NULL DEFAULT '0.0.0.0',
    database_username text NOT NULL,
    encrypted_password text NOT NULL,
    database_name text NOT NULL DEFAULT '',
    connection_uri text NOT NULL DEFAULT '',
    jdbc_uri text NOT NULL DEFAULT '',
    compose_project text NOT NULL UNIQUE,
    remote_directory text NOT NULL,
    configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_healthy_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (host_id, host_port)
);
CREATE UNIQUE INDEX IF NOT EXISTS instances_name_lower_idx ON instances (lower(name)) WHERE status <> 'deleted';
CREATE INDEX IF NOT EXISTS instances_host_idx ON instances (host_id, status);

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

CREATE TABLE IF NOT EXISTS tasks (
    id uuid PRIMARY KEY,
    kind text NOT NULL,
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled', 'interrupted')),
    resource_type text NOT NULL,
    resource_id uuid,
    requested_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    host_id uuid REFERENCES hosts(id) ON DELETE SET NULL,
    progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    stage text NOT NULL DEFAULT 'queued',
    message text NOT NULL DEFAULT '',
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb NOT NULL DEFAULT '{}'::jsonb,
    error_code text NOT NULL DEFAULT '',
    error_message text NOT NULL DEFAULT '',
    cancelable boolean NOT NULL DEFAULT true,
    cancel_asked boolean NOT NULL DEFAULT false,
    attempts integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks (status, created_at);
CREATE INDEX IF NOT EXISTS tasks_resource_idx ON tasks (resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tasks_active_image_artifact_idx ON tasks ((payload->>'imageArtifactId'))
    WHERE status IN ('queued', 'running') AND payload ? 'imageArtifactId';
CREATE INDEX IF NOT EXISTS tasks_active_registry_idx ON tasks ((payload->>'registryId'))
    WHERE status IN ('queued', 'running') AND payload ? 'registryId';
CREATE INDEX IF NOT EXISTS tasks_active_backup_idx ON tasks ((payload->>'backupId'))
    WHERE status IN ('queued', 'running') AND payload ? 'backupId';

CREATE TABLE IF NOT EXISTS task_logs (
    id bigserial PRIMARY KEY,
    task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    level text NOT NULL DEFAULT 'info',
    message text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_logs_task_idx ON task_logs (task_id, id);

CREATE TABLE IF NOT EXISTS metric_samples (
    id bigserial PRIMARY KEY,
    host_id uuid NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
    instance_id uuid REFERENCES instances(id) ON DELETE CASCADE,
    cpu_percent double precision NOT NULL DEFAULT 0,
    memory_bytes bigint NOT NULL DEFAULT 0,
    memory_percent double precision NOT NULL DEFAULT 0,
    disk_used_bytes bigint NOT NULL DEFAULT 0,
    disk_total_bytes bigint NOT NULL DEFAULT 0,
    collected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS metric_samples_host_time_idx ON metric_samples (host_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS metric_samples_instance_time_idx ON metric_samples (instance_id, collected_at DESC);

CREATE TABLE IF NOT EXISTS alerts (
    id uuid PRIMARY KEY,
    severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    type text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
    created_at timestamptz NOT NULL DEFAULT now(),
    acknowledged_at timestamptz,
    resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS alerts_status_time_idx ON alerts (status, created_at DESC);

CREATE TABLE IF NOT EXISTS webhooks (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    url text NOT NULL,
    encrypted_secret text NOT NULL DEFAULT '',
    events jsonb NOT NULL DEFAULT '["*"]'::jsonb,
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id uuid PRIMARY KEY,
    webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_id uuid NOT NULL,
    event_type text NOT NULL,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    response_status integer,
    response_body text NOT NULL DEFAULT '',
    error_message text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_queue_idx ON webhook_deliveries (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS audit_logs (
    id bigserial PRIMARY KEY,
    user_id uuid REFERENCES users(id) ON DELETE SET NULL,
    username text NOT NULL DEFAULT '',
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid,
    resource_name text NOT NULL DEFAULT '',
    ip text NOT NULL DEFAULT '',
    request_id text NOT NULL DEFAULT '',
    task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
    result text NOT NULL,
    changes jsonb NOT NULL DEFAULT '{}'::jsonb,
    message text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_time_idx ON audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_resource_idx ON audit_logs (resource_type, resource_id, created_at DESC);

CREATE TABLE IF NOT EXISTS image_artifacts (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    filename text NOT NULL,
    path text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL UNIQUE,
    format text NOT NULL,
    image_refs text[] NOT NULL DEFAULT '{}'::text[],
    architectures text[] NOT NULL DEFAULT '{}'::text[],
    status text NOT NULL DEFAULT 'ready',
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);

CREATE TABLE IF NOT EXISTS uploads (
    id uuid PRIMARY KEY,
    filename text NOT NULL,
    temporary_path text NOT NULL,
    total_bytes bigint NOT NULL,
    received_bytes bigint NOT NULL DEFAULT 0,
    expected_sha256 text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'uploading',
    created_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
    ('timezone', '"Asia/Shanghai"'::jsonb),
    ('monitoring', '{"intervalSeconds":30,"retentionDays":7,"diskWarningPercent":80,"diskCriticalPercent":90,"alerts":{"hostOffline":true,"sshCredentialInvalid":true,"containerExited":true,"containerUnhealthy":true,"restartFailed":true,"diskWarning":true,"diskCritical":true,"upgradeFailed":true}}'::jsonb),
    ('uploads', '{"maxBytes":53687091200,"chunkBytes":8388608}'::jsonb)
ON CONFLICT (key) DO NOTHING;
