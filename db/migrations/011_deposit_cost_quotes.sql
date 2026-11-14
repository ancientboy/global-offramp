BEGIN;
-- Additive only. Existing payments retain their original same-network settlement rule.
ALTER TABLE workspace.funding_payments ADD COLUMN IF NOT EXISTS settlement_network text;
ALTER TABLE workspace.funding_payments ADD COLUMN IF NOT EXISTS cost_quote jsonb;
COMMIT;
