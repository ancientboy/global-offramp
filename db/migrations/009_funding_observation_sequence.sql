-- An observation's order is financial control data, not a wall-clock timestamp.
BEGIN;
CREATE SEQUENCE IF NOT EXISTS workspace.funding_observation_sequence;
ALTER TABLE workspace.funding_payments ADD COLUMN IF NOT EXISTS last_observation bigint NOT NULL DEFAULT 0;
COMMIT;
