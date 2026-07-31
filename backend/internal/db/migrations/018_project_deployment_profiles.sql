CREATE TABLE project_deployment_profiles (
    project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
    template_version_id uuid NOT NULL REFERENCES template_versions(id) ON DELETE CASCADE,
    cpu double precision NOT NULL CHECK (cpu > 0),
    memory_bytes bigint NOT NULL CHECK (memory_bytes > 0),
    disk_bytes bigint NOT NULL CHECK (disk_bytes > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_deployment_profiles_template_version_idx
    ON project_deployment_profiles(template_version_id);
