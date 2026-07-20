ALTER TABLE hosts
    ADD COLUMN IF NOT EXISTS data_root_writable boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS port_probe_available boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS available_port integer NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'hosts_available_port_check' AND conrelid = 'hosts'::regclass
    ) THEN
        ALTER TABLE hosts
            ADD CONSTRAINT hosts_available_port_check
            CHECK (available_port = 0 OR available_port BETWEEN 1 AND 65535);
    END IF;
END $$;
