BEGIN;
CREATE TABLE IF NOT EXISTS workspace.partners (
 id text PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 invite_code text NOT NULL UNIQUE CHECK(invite_code ~ '^[A-Za-z0-9_-]{32}$'),
 status text NOT NULL CHECK(status IN('active','disabled')),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
);
ALTER TABLE workspace.accounts ADD COLUMN IF NOT EXISTS partner_id text UNIQUE REFERENCES workspace.partners(id);
ALTER TABLE workspace.accounts DROP CONSTRAINT IF EXISTS accounts_role_check;
ALTER TABLE workspace.accounts ADD CONSTRAINT accounts_role_check CHECK(role IN('customer','merchant_admin','payout_provider','partner'));
ALTER TABLE workspace.accounts DROP CONSTRAINT IF EXISTS accounts_identity_check;
ALTER TABLE workspace.accounts ADD CONSTRAINT accounts_identity_check CHECK(
 (role='customer' AND customer_id IS NOT NULL AND payout_provider_id IS NULL AND partner_id IS NULL AND ((email IS NOT NULL AND username IS NULL) OR (email IS NULL AND username IS NOT NULL)))
 OR (role='merchant_admin' AND customer_id IS NULL AND payout_provider_id IS NULL AND partner_id IS NULL AND username IS NOT NULL AND email IS NULL)
 OR (role='payout_provider' AND customer_id IS NULL AND payout_provider_id IS NOT NULL AND length(payout_provider_id)>0 AND partner_id IS NULL AND username IS NOT NULL AND email IS NULL)
 OR (role='partner' AND customer_id IS NULL AND payout_provider_id IS NULL AND partner_id IS NOT NULL AND username IS NOT NULL AND email IS NULL)
);
CREATE TABLE IF NOT EXISTS workspace.customer_attributions (
 customer_id text PRIMARY KEY REFERENCES workspace.customers(id),
 partner_id text NOT NULL REFERENCES workspace.partners(id),
 invite_code_hash text NOT NULL CHECK(length(invite_code_hash)=64),
 created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_attributions_partner ON workspace.customer_attributions(partner_id);
DROP TRIGGER IF EXISTS customer_attributions_immutable ON workspace.customer_attributions;
CREATE TRIGGER customer_attributions_immutable BEFORE UPDATE OR DELETE ON workspace.customer_attributions FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
COMMIT;
