CREATE INDEX IF NOT EXISTS tasks_active_image_artifact_idx ON tasks ((payload->>'imageArtifactId'))
    WHERE status IN ('queued', 'running') AND payload ? 'imageArtifactId';

CREATE INDEX IF NOT EXISTS tasks_active_registry_idx ON tasks ((payload->>'registryId'))
    WHERE status IN ('queued', 'running') AND payload ? 'registryId';
