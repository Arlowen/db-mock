CREATE INDEX IF NOT EXISTS tasks_instance_scope_idx
    ON tasks ((payload->>'instanceId'), created_at DESC)
    WHERE payload ? 'instanceId';
