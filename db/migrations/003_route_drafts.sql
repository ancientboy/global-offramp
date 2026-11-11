-- Draft commercial configuration only; never enables deposits or payout execution.
BEGIN;
CREATE TABLE IF NOT EXISTS workspace.route_drafts (
 route_id text PRIMARY KEY CHECK(route_id ~ '^(USDT|USDC)-(CNY|USD|EUR|MXN|BRL|GBP)$'),
 version integer NOT NULL CHECK(version > 0),
 document jsonb NOT NULL,
 updated_by uuid NOT NULL REFERENCES workspace.accounts(id),
 updated_at timestamptz NOT NULL
);
COMMIT;
