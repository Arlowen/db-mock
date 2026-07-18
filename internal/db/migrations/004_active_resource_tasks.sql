WITH ranked AS (
    SELECT id,
           row_number() OVER (
               PARTITION BY resource_type, resource_id
               ORDER BY CASE WHEN status = 'running' THEN 0 ELSE 1 END, created_at
           ) AS position
    FROM tasks
    WHERE resource_id IS NOT NULL AND status IN ('queued', 'running')
)
UPDATE tasks
SET status = 'interrupted',
    stage = 'interrupted',
    error_code = 'conflicting_active_task',
    error_message = 'Another operation for this resource was already active',
    cancelable = false,
    finished_at = now(),
    updated_at = now()
WHERE id IN (SELECT id FROM ranked WHERE position > 1);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_active_resource_idx
    ON tasks (resource_type, resource_id)
    WHERE resource_id IS NOT NULL AND status IN ('queued', 'running');
