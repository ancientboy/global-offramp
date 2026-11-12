BEGIN;
ALTER TABLE workspace.accounts ADD COLUMN IF NOT EXISTS payout_provider_id text;
ALTER TABLE workspace.accounts DROP CONSTRAINT IF EXISTS accounts_role_check;
ALTER TABLE workspace.accounts ADD CONSTRAINT accounts_role_check CHECK(role IN('customer','merchant_admin','payout_provider'));
ALTER TABLE workspace.accounts DROP CONSTRAINT IF EXISTS accounts_identity_check;
ALTER TABLE workspace.accounts ADD CONSTRAINT accounts_identity_check CHECK(
 (role='customer' AND customer_id IS NOT NULL AND payout_provider_id IS NULL AND ((email IS NOT NULL AND username IS NULL) OR (email IS NULL AND username IS NOT NULL)))
 OR (role='merchant_admin' AND customer_id IS NULL AND payout_provider_id IS NULL AND username IS NOT NULL AND email IS NULL)
 OR (role='payout_provider' AND customer_id IS NULL AND payout_provider_id IS NOT NULL AND length(payout_provider_id)>0 AND username IS NOT NULL AND email IS NULL)
);
COMMIT;
