-- Apply in the dedicated workspace database AFTER db-runtime.sql, as migration owner.
BEGIN;
CREATE SCHEMA IF NOT EXISTS workspace;
CREATE TABLE IF NOT EXISTS workspace.customers (
 id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('personal','company')), created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace.accounts (
 id uuid PRIMARY KEY, email text UNIQUE CHECK(email=lower(email)),
 username text UNIQUE CHECK(username=lower(username) AND username ~ '^[a-z0-9_][a-z0-9_.-]{2,31}$'),
 display_name text NOT NULL, password_hash text NOT NULL,
 role text NOT NULL CHECK(role IN ('customer','merchant_admin')),
 customer_id text UNIQUE REFERENCES workspace.customers(id),
 enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL,
 CHECK((role='customer' AND customer_id IS NOT NULL AND email IS NOT NULL AND username IS NULL)
   OR (role='merchant_admin' AND customer_id IS NULL AND username IS NOT NULL AND email IS NULL))
);
CREATE TABLE IF NOT EXISTS workspace.sessions (
 token_hash text PRIMARY KEY CHECK(length(token_hash)=64),
 account_id uuid NOT NULL REFERENCES workspace.accounts(id),
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 revoked_at timestamptz, CHECK(expires_at>created_at)
);
CREATE INDEX IF NOT EXISTS workspace_sessions_account ON workspace.sessions(account_id);
CREATE TABLE IF NOT EXISTS workspace.auth_audit (
 id uuid PRIMARY KEY, actor_id uuid REFERENCES workspace.accounts(id),
 action text NOT NULL, subject_hash text, created_at timestamptz NOT NULL
);
DROP TRIGGER IF EXISTS auth_audit_immutable ON workspace.auth_audit;
CREATE TRIGGER auth_audit_immutable BEFORE UPDATE OR DELETE ON workspace.auth_audit
 FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
CREATE TABLE IF NOT EXISTS workspace.rate_limits (
 key_hash text PRIMARY KEY, window_start timestamptz NOT NULL,
 count integer NOT NULL CHECK(count>0)
);
COMMIT;
