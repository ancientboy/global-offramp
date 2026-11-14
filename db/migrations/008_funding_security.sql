BEGIN;
CREATE TABLE IF NOT EXISTS workspace.funds_environment (
 id integer PRIMARY KEY CHECK(id=1), mode text NOT NULL CHECK(mode IN ('sandbox','live')), created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS funds_environment_immutable ON workspace.funds_environment;
CREATE TRIGGER funds_environment_immutable BEFORE UPDATE OR DELETE ON workspace.funds_environment FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
CREATE TABLE IF NOT EXISTS workspace.account_security (
 account_id uuid PRIMARY KEY REFERENCES workspace.accounts(id),
 password_changed_at timestamptz, totp_secret text, pending_secret text,
 last_totp_counter bigint NOT NULL DEFAULT -1, recovery_hashes jsonb NOT NULL DEFAULT '[]',
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workspace.sessions ADD COLUMN IF NOT EXISTS mfa_verified_at timestamptz;
CREATE TABLE IF NOT EXISTS workspace.funding_payments (
 id text PRIMARY KEY, account_id uuid NOT NULL REFERENCES workspace.accounts(id),
 customer_id text NOT NULL REFERENCES workspace.customers(id), idempotency_key text NOT NULL,
 currency text NOT NULL CHECK(currency IN ('USDT','USDC')), pay_currency text NOT NULL,
 requested_amount numeric(30,6) NOT NULL CHECK(requested_amount>0),
 provider_id text UNIQUE, pay_address text, pay_amount text, extra_id text,
 status text NOT NULL DEFAULT 'creating', review_reason text,
 credited_amount numeric(30,6), journal_id uuid UNIQUE REFERENCES runtime.journals(id) DEFERRABLE INITIALLY DEFERRED,
 next_check_at timestamptz NOT NULL DEFAULT now(), checked_at timestamptz, last_observation_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(account_id,idempotency_key), CHECK((journal_id IS NULL)=(credited_amount IS NULL)),
 CHECK(credited_amount IS NULL OR credited_amount>0)
);
CREATE INDEX IF NOT EXISTS funding_pending ON workspace.funding_payments(next_check_at);
CREATE TABLE IF NOT EXISTS workspace.funding_inbox (
 digest text PRIMARY KEY, payment_id text NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS funding_inbox_immutable ON workspace.funding_inbox;
CREATE TRIGGER funding_inbox_immutable BEFORE UPDATE OR DELETE ON workspace.funding_inbox FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
CREATE TABLE IF NOT EXISTS workspace.operational_alerts (
 id text PRIMARY KEY, kind text NOT NULL, resource_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(kind,resource_id)
);
DROP TRIGGER IF EXISTS operational_alerts_immutable ON workspace.operational_alerts;
CREATE TRIGGER operational_alerts_immutable BEFORE UPDATE OR DELETE ON workspace.operational_alerts FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
COMMIT;
