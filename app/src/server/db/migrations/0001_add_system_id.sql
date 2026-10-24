ALTER TABLE ships ADD COLUMN system_id TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE resource_node_state ADD COLUMN system_id TEXT NOT NULL DEFAULT 'unknown';
