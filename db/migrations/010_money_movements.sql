BEGIN;
CREATE TABLE IF NOT EXISTS workspace.money_movements (
 id text PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('refund','provider_settlement')),
 customer_id text REFERENCES workspace.customers(id), provider_id text,
 currency text NOT NULL CHECK(currency IN ('USDT','USDC')), network text NOT NULL CHECK(network IN ('usdttrc20','usdcbase')),
 amount numeric(30,6) NOT NULL CHECK(amount>0), destination text NOT NULL,
 requested_by uuid NOT NULL REFERENCES workspace.accounts(id), idempotency_key text NOT NULL,
 reason text NOT NULL, status text NOT NULL CHECK(status IN ('requested','approved','cancelled','rejected','completed')),
 approved_by uuid REFERENCES workspace.accounts(id), approved_at timestamptz,
 reserve_journal uuid NOT NULL UNIQUE REFERENCES runtime.journals(id) DEFERRABLE INITIALLY DEFERRED,
 closing_journal uuid UNIQUE REFERENCES runtime.journals(id) DEFERRABLE INITIALLY DEFERRED,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(requested_by,idempotency_key),
 CHECK((kind='refund' AND customer_id IS NOT NULL AND provider_id IS NULL) OR (kind='provider_settlement' AND provider_id IS NOT NULL AND customer_id IS NULL)),
 CHECK((network='usdttrc20' AND currency='USDT') OR (network='usdcbase' AND currency='USDC')),
 CHECK((status IN ('cancelled','rejected','completed'))=(closing_journal IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS workspace.money_movement_events (
 id uuid PRIMARY KEY, movement_id text NOT NULL REFERENCES workspace.money_movements(id),
 actor_id uuid NOT NULL REFERENCES workspace.accounts(id), action text NOT NULL,
 note text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS movement_events_immutable ON workspace.money_movement_events;
CREATE TRIGGER movement_events_immutable BEFORE UPDATE OR DELETE ON workspace.money_movement_events FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
CREATE TABLE IF NOT EXISTS workspace.chain_transfer_claims (
 network text NOT NULL, txid text NOT NULL, log_index integer NOT NULL CHECK(log_index>=0),
 movement_id text NOT NULL UNIQUE REFERENCES workspace.money_movements(id),
 block_number text NOT NULL, block_hash text NOT NULL, source_address text NOT NULL,
 verified_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(network,txid,log_index)
);
DROP TRIGGER IF EXISTS chain_claims_immutable ON workspace.chain_transfer_claims;
CREATE TRIGGER chain_claims_immutable BEFORE UPDATE OR DELETE ON workspace.chain_transfer_claims FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
-- Store an immutable approval payload and prevent even application-level accidental destination changes.
CREATE OR REPLACE FUNCTION workspace.lock_movement_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW.kind,NEW.customer_id,NEW.provider_id,NEW.currency,NEW.network,NEW.amount,NEW.destination,NEW.requested_by,NEW.idempotency_key,NEW.reason,NEW.reserve_journal,NEW.created_at) IS DISTINCT FROM ROW(OLD.id,OLD.kind,OLD.customer_id,OLD.provider_id,OLD.currency,OLD.network,OLD.amount,OLD.destination,OLD.requested_by,OLD.idempotency_key,OLD.reason,OLD.reserve_journal,OLD.created_at) THEN RAISE EXCEPTION 'money movement identity is immutable'; END IF;
 IF OLD.status IN ('cancelled','rejected','completed') THEN RAISE EXCEPTION 'money movement is closed'; END IF;
 IF OLD.status='requested' AND NEW.status NOT IN ('approved','cancelled','rejected') THEN RAISE EXCEPTION 'invalid money movement transition'; END IF;
 IF NEW.status IN ('approved','completed') AND (NEW.approved_at IS NULL OR NEW.approved_by IS NULL) THEN RAISE EXCEPTION 'approval is required'; END IF;
 IF NEW.status='completed' AND NOT EXISTS(SELECT 1 FROM workspace.chain_transfer_claims WHERE movement_id=NEW.id) THEN RAISE EXCEPTION 'verified transfer claim is required'; END IF;
 IF OLD.status='approved' AND NEW.status<>'completed' THEN RAISE EXCEPTION 'approved funds remain reserved until verified payment'; END IF;
 IF OLD.approved_at IS NOT NULL AND ROW(NEW.approved_at,NEW.approved_by) IS DISTINCT FROM ROW(OLD.approved_at,OLD.approved_by) THEN RAISE EXCEPTION 'approval is immutable'; END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS movement_identity_immutable ON workspace.money_movements;
CREATE TRIGGER movement_identity_immutable BEFORE UPDATE ON workspace.money_movements FOR EACH ROW EXECUTE FUNCTION workspace.lock_movement_identity();
COMMIT;
BEGIN;
ALTER TABLE workspace.funding_payments ADD COLUMN IF NOT EXISTS allow_partial_credit boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS workspace.funding_reviews (
 id uuid PRIMARY KEY, payment_id text NOT NULL REFERENCES workspace.funding_payments(id),
 actor_id uuid NOT NULL REFERENCES workspace.accounts(id), decision text NOT NULL, note text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS funding_reviews_immutable ON workspace.funding_reviews;
CREATE TRIGGER funding_reviews_immutable BEFORE UPDATE OR DELETE ON workspace.funding_reviews FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
COMMIT;
CREATE INDEX IF NOT EXISTS movement_customer_history ON workspace.money_movements(customer_id,created_at DESC) WHERE kind='refund';
CREATE INDEX IF NOT EXISTS movement_provider_history ON workspace.money_movements(provider_id,created_at DESC) WHERE kind='provider_settlement';
CREATE INDEX IF NOT EXISTS movement_pending_age ON workspace.money_movements(updated_at) WHERE status IN ('requested','approved');
CREATE INDEX IF NOT EXISTS movement_event_history ON workspace.money_movement_events(movement_id,created_at);
