BEGIN;
ALTER TABLE workspace.funding_payments ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'nowpayments' CHECK(source IN ('nowpayments','direct_tron'));
ALTER TABLE workspace.funding_payments ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE workspace.funding_payments DROP CONSTRAINT IF EXISTS direct_deposit_identity;
ALTER TABLE workspace.funding_payments ADD CONSTRAINT direct_deposit_identity CHECK(source<>'direct_tron' OR COALESCE((currency='USDT' AND pay_currency='usdttrc20' AND settlement_network='usdttrc20' AND pay_address='TKcBJk4ZU9qVt3CtDK4usYiEDvNKMD6tnA' AND pay_amount ~ '^[0-9]+\.[0-9]{6}$' AND expires_at IS NOT NULL AND provider_id IS NULL AND expires_at>created_at),false));
-- Exact amounts are never reused, even after expiration or credit.
CREATE UNIQUE INDEX IF NOT EXISTS direct_deposit_amount ON workspace.funding_payments(pay_address,pay_amount) WHERE source='direct_tron';
CREATE TABLE IF NOT EXISTS workspace.direct_deposit_scan (
 id integer PRIMARY KEY CHECK(id=1), receiver text NOT NULL CHECK(receiver='TKcBJk4ZU9qVt3CtDK4usYiEDvNKMD6tnA'),
 scanned_through bigint NOT NULL, rescan_through bigint NOT NULL, checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS workspace.direct_deposit_events (
 txid text NOT NULL CHECK(txid ~ '^[a-f0-9]{64}$'), log_index integer NOT NULL CHECK(log_index>=0),
 receiver text NOT NULL CHECK(receiver='TKcBJk4ZU9qVt3CtDK4usYiEDvNKMD6tnA'), source_hex text NOT NULL,
 amount numeric(30,6) NOT NULL CHECK(amount>0), block_number bigint NOT NULL, block_hash text NOT NULL,
 block_time timestamptz NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(txid,log_index)
);
CREATE TABLE IF NOT EXISTS workspace.direct_deposit_claims (
 txid text NOT NULL, log_index integer NOT NULL, payment_id text NOT NULL UNIQUE REFERENCES workspace.funding_payments(id),
 PRIMARY KEY(txid,log_index), FOREIGN KEY(txid,log_index) REFERENCES workspace.direct_deposit_events(txid,log_index)
);
DROP TRIGGER IF EXISTS direct_events_immutable ON workspace.direct_deposit_events;
CREATE TRIGGER direct_events_immutable BEFORE UPDATE OR DELETE ON workspace.direct_deposit_events FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
DROP TRIGGER IF EXISTS direct_claims_immutable ON workspace.direct_deposit_claims;
CREATE TRIGGER direct_claims_immutable BEFORE UPDATE OR DELETE ON workspace.direct_deposit_claims FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
CREATE OR REPLACE FUNCTION workspace.lock_direct_deposit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source<>OLD.source OR (OLD.source='direct_tron' AND ROW(NEW.account_id,NEW.customer_id,NEW.idempotency_key,NEW.currency,NEW.pay_currency,NEW.requested_amount,NEW.pay_address,NEW.pay_amount,NEW.settlement_network,NEW.created_at,NEW.expires_at) IS DISTINCT FROM ROW(OLD.account_id,OLD.customer_id,OLD.idempotency_key,OLD.currency,OLD.pay_currency,OLD.requested_amount,OLD.pay_address,OLD.pay_amount,OLD.settlement_network,OLD.created_at,OLD.expires_at)) THEN RAISE EXCEPTION 'deposit identity is immutable'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS direct_identity_immutable ON workspace.funding_payments;
CREATE TRIGGER direct_identity_immutable BEFORE UPDATE ON workspace.funding_payments FOR EACH ROW EXECUTE FUNCTION workspace.lock_direct_deposit();
-- One native transfer event cannot fund an incoming credit and an outgoing settlement.
CREATE OR REPLACE FUNCTION workspace.no_recycled_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.txid));
 IF TG_TABLE_NAME='direct_deposit_events' THEN
  IF EXISTS(SELECT 1 FROM workspace.chain_transfer_claims WHERE network='usdttrc20' AND txid=NEW.txid AND log_index=NEW.log_index) THEN RAISE EXCEPTION 'outgoing transfer cannot be a deposit'; END IF;
 ELSE
  IF NEW.network='usdttrc20' AND EXISTS(SELECT 1 FROM workspace.direct_deposit_events WHERE txid=NEW.txid AND log_index=NEW.log_index) THEN RAISE EXCEPTION 'incoming transfer cannot be an outgoing payment'; END IF;
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS direct_no_recycled ON workspace.direct_deposit_events;
CREATE TRIGGER direct_no_recycled BEFORE INSERT ON workspace.direct_deposit_events FOR EACH ROW EXECUTE FUNCTION workspace.no_recycled_transfer();
DROP TRIGGER IF EXISTS outgoing_no_recycled ON workspace.chain_transfer_claims;
CREATE TRIGGER outgoing_no_recycled BEFORE INSERT ON workspace.chain_transfer_claims FOR EACH ROW EXECUTE FUNCTION workspace.no_recycled_transfer();
COMMIT;
