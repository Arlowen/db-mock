ALTER TABLE instances
    DROP CONSTRAINT IF EXISTS instances_host_id_fkey;
ALTER TABLE instances
    ALTER COLUMN host_id DROP NOT NULL;
ALTER TABLE instances
    ADD CONSTRAINT instances_host_id_fkey
        FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL;

ALTER TABLE instance_backups
    DROP CONSTRAINT IF EXISTS instance_backups_host_id_fkey;
ALTER TABLE instance_backups
    ADD CONSTRAINT instance_backups_host_id_fkey
        FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE;
