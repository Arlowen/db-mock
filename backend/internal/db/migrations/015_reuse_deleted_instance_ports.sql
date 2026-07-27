ALTER TABLE instances
    DROP CONSTRAINT IF EXISTS instances_host_id_host_port_key;

CREATE UNIQUE INDEX IF NOT EXISTS instances_active_host_port_idx
    ON instances (host_id, host_port)
    WHERE status <> 'deleted';
