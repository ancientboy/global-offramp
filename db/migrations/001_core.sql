-- PostgreSQL 15+. Apply exactly once to an empty database/schema.
-- Mock MVP source only: no provider credentials, production permissions, or real funds.
BEGIN;
CREATE SCHEMA offramp;
SET search_path = offramp, public;

CREATE DOMAIN exact_amount AS numeric(38,18)
  CHECK (VALUE NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric));

CREATE FUNCTION json_amount_matches(document jsonb,key text,amount numeric) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(document->key) = 'string'
      AND document->>key ~ '^(0|[1-9][0-9]*)([.][0-9]{1,18})?$'
    THEN (document->>key)::numeric = amount ELSE false END
$$;

CREATE TABLE currencies (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z][A-Z0-9]{1,11}$'),
  minor_units smallint NOT NULL CHECK (minor_units BETWEEN 0 AND 18)
);
-- Accounting precision registry, not an enabled payout-route list.
-- EUR is retained for cross-currency invariant regressions.
INSERT INTO currencies VALUES ('CNY',2),('USD',2),('EUR',2),('USDT',6),('USDC',6);

CREATE TABLE actors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('human','service')),
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_type text NOT NULL CHECK (account_type IN ('personal','company')),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  external_subject text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','suspended','closed')),
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE beneficiaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  display_name text NOT NULL,
  bank_name text NOT NULL,
  bank_account_ref text NOT NULL, -- Mock/vault reference only; never log raw bank details.
  account_fingerprint text NOT NULL,
  currency text NOT NULL REFERENCES currencies,
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','blocked','retired')),
  created_by uuid NOT NULL REFERENCES actors,
  approved_by uuid REFERENCES actors,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,customer_id),
  UNIQUE (customer_id,account_fingerprint,version),
  CHECK (approved_by IS NULL OR approved_by <> created_by),
  CHECK (status <> 'active' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);

CREATE TABLE partners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE commission_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners,
  version integer NOT NULL CHECK (version > 0),
  basis text NOT NULL CHECK (basis IN ('fee','spread','fixed')),
  rate exact_amount NOT NULL DEFAULT 0 CHECK (rate BETWEEN 0 AND 1),
  fixed_amount exact_amount NOT NULL DEFAULT 0 CHECK (fixed_amount >= 0),
  currency text NOT NULL REFERENCES currencies,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id,version),
  UNIQUE (id,partner_id),
  CHECK (jsonb_typeof(snapshot) = 'object'),
  CHECK (coalesce(snapshot->>'version' = version::text,false)),
  CHECK (coalesce(snapshot->>'basis' = basis,false)),
  CHECK (json_amount_matches(snapshot,'rate',rate)),
  CHECK ((basis = 'fixed' AND rate = 0) OR (basis <> 'fixed' AND fixed_amount = 0))
);

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers,
  version integer NOT NULL CHECK (version > 0),
  input_currency text NOT NULL REFERENCES currencies,
  output_currency text NOT NULL REFERENCES currencies,
  input_amount exact_amount NOT NULL CHECK (input_amount > 0),
  rate exact_amount NOT NULL CHECK (rate > 0),
  gross_output_amount exact_amount NOT NULL CHECK (gross_output_amount > 0),
  fee_amount exact_amount NOT NULL CHECK (fee_amount >= 0),
  net_output_amount exact_amount NOT NULL CHECK (net_output_amount > 0),
  spread_revenue exact_amount NOT NULL DEFAULT 0 CHECK (spread_revenue >= 0),
  snapshot jsonb NOT NULL, -- All monetary JSON fields are decimal strings.
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,customer_id),
  CHECK (net_output_amount = gross_output_amount - fee_amount),
  CHECK (expires_at > created_at),
  CHECK (jsonb_typeof(snapshot) = 'object'),
  CHECK (coalesce(snapshot->>'version' = version::text,false)),
  CHECK (json_amount_matches(snapshot,'inputAmount',input_amount)),
  CHECK (json_amount_matches(snapshot,'rate',rate)),
  CHECK (json_amount_matches(snapshot,'grossOutputAmount',gross_output_amount)),
  CHECK (json_amount_matches(snapshot,'feeAmount',fee_amount)),
  CHECK (json_amount_matches(snapshot,'netOutputAmount',net_output_amount))
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers,
  client_order_id text NOT NULL,
  quote_id uuid NOT NULL UNIQUE,
  beneficiary_id uuid NOT NULL,
  beneficiary_snapshot jsonb NOT NULL,
  deposit_currency text NOT NULL REFERENCES currencies,
  payout_currency text NOT NULL REFERENCES currencies,
  expected_deposit_amount exact_amount NOT NULL CHECK (expected_deposit_amount > 0),
  received_deposit_amount exact_amount NOT NULL DEFAULT 0 CHECK (received_deposit_amount >= 0),
  payout_amount exact_amount NOT NULL CHECK (payout_amount > 0),
  deposit_address_ref text NOT NULL,
  deposit_state text NOT NULL DEFAULT 'awaiting'
    CHECK (deposit_state IN ('awaiting','seen','confirmed','underpaid','overpaid','late','quarantined','returned')),
  payout_state text NOT NULL DEFAULT 'not_ready'
    CHECK (payout_state IN ('not_ready','ready','pending_approval','approved','submitting','processing','unknown','succeeded','failed','cancelled','refunded')),
  receipt_state text NOT NULL DEFAULT 'not_available'
    CHECK (receipt_state IN ('not_available','pending','available','failed')),
  receipt_ref text,
  row_version bigint NOT NULL DEFAULT 1 CHECK (row_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id,client_order_id),
  UNIQUE (id,customer_id),
  FOREIGN KEY (quote_id,customer_id) REFERENCES quotes (id,customer_id),
  FOREIGN KEY (beneficiary_id,customer_id) REFERENCES beneficiaries (id,customer_id),
  CHECK (jsonb_typeof(beneficiary_snapshot) = 'object'),
  CHECK (receipt_state <> 'available' OR (receipt_ref IS NOT NULL AND payout_state = 'succeeded')),
  CHECK (payout_state NOT IN ('ready','pending_approval','approved','submitting','processing','unknown','succeeded')
         OR (deposit_state = 'confirmed' AND received_deposit_amount >= expected_deposit_amount))
);

CREATE TABLE order_attributions (
  order_id uuid PRIMARY KEY REFERENCES orders,
  partner_id uuid NOT NULL REFERENCES partners,
  rule_version_id uuid NOT NULL,
  source text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id,partner_id),
  FOREIGN KEY (rule_version_id,partner_id) REFERENCES commission_rule_versions (id,partner_id),
  CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_event_id text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb NOT NULL,
  signature_verified boolean NOT NULL CHECK (signature_verified),
  processing_state text NOT NULL DEFAULT 'received'
    CHECK (processing_state IN ('received','processed','quarantined')),
  failure_reason text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider,external_event_id),
  CHECK (processing_state <> 'processed' OR processed_at IS NOT NULL)
);

-- Ownership of an on-chain output is immutable across confirmation observations.
CREATE TABLE deposit_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders,
  network text NOT NULL,
  transaction_hash text NOT NULL,
  event_index integer NOT NULL DEFAULT 0 CHECK (event_index >= 0),
  currency text NOT NULL REFERENCES currencies,
  amount exact_amount NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network,transaction_hash,event_index),
  UNIQUE (network,transaction_hash,event_index,order_id,currency,amount)
);

CREATE TABLE deposit_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders,
  webhook_event_id uuid NOT NULL REFERENCES webhook_events,
  network text NOT NULL,
  transaction_hash text NOT NULL,
  event_index integer NOT NULL DEFAULT 0 CHECK (event_index >= 0),
  currency text NOT NULL REFERENCES currencies,
  amount exact_amount NOT NULL CHECK (amount > 0),
  confirmations integer NOT NULL CHECK (confirmations >= 0),
  required_confirmations integer NOT NULL CHECK (required_confirmations > 0),
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (network,transaction_hash,event_index,confirmations),
  UNIQUE (webhook_event_id,event_index),
  FOREIGN KEY (network,transaction_hash,event_index,order_id,currency,amount)
    REFERENCES deposit_transfers (network,transaction_hash,event_index,order_id,currency,amount)
);

CREATE TABLE payout_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  provider text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  beneficiary_id uuid NOT NULL REFERENCES beneficiaries,
  beneficiary_snapshot jsonb NOT NULL,
  currency text NOT NULL REFERENCES currencies,
  amount exact_amount NOT NULL CHECK (amount > 0),
  state text NOT NULL DEFAULT 'awaiting_approval'
    CHECK (state IN ('awaiting_approval','approved','submitting','processing','unknown','succeeded','failed','cancelled')),
  maker_id uuid NOT NULL REFERENCES actors,
  checker_id uuid REFERENCES actors,
  approved_at timestamptz,
  provider_transfer_id text,
  definitive_failure boolean NOT NULL DEFAULT false,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id,attempt_number),
  UNIQUE (provider,provider_transfer_id),
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CHECK (state NOT IN ('approved','submitting','processing','unknown','succeeded','failed')
         OR (checker_id IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK ((state = 'failed' AND definitive_failure AND evidence IS NOT NULL)
         OR (state <> 'failed' AND NOT definitive_failure)),
  CHECK (state <> 'succeeded' OR provider_transfer_id IS NOT NULL)
);
-- A successful, uncertain, processing, or unsubmitted live attempt blocks another attempt.
CREATE UNIQUE INDEX payout_one_live_or_successful ON payout_attempts (order_id)
  WHERE state NOT IN ('failed','cancelled');

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL UNIQUE REFERENCES orders,
  idempotency_key text NOT NULL UNIQUE,
  currency text NOT NULL REFERENCES currencies,
  amount exact_amount NOT NULL CHECK (amount > 0),
  destination_ref text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'awaiting_approval'
    CHECK (state IN ('awaiting_approval','approved','submitting','processing','unknown','succeeded','failed','cancelled')),
  maker_id uuid NOT NULL REFERENCES actors,
  checker_id uuid REFERENCES actors,
  approved_at timestamptz,
  provider text NOT NULL,
  provider_refund_id text,
  definitive_failure boolean NOT NULL DEFAULT false,
  evidence jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider,provider_refund_id),
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CHECK (state NOT IN ('approved','submitting','processing','unknown','succeeded','failed')
         OR (checker_id IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK ((state = 'failed' AND definitive_failure AND evidence IS NOT NULL)
         OR (state <> 'failed' AND NOT definitive_failure)),
  CHECK (state <> 'succeeded' OR provider_refund_id IS NOT NULL)
);

CREATE TABLE ledger_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  currency text NOT NULL REFERENCES currencies,
  kind text NOT NULL CHECK (kind IN ('asset','liability','equity','revenue','expense')),
  customer_id uuid REFERENCES customers,
  partner_id uuid REFERENCES partners,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,currency),
  CHECK (customer_id IS NULL OR partner_id IS NULL)
);

CREATE TABLE ledger_journals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('deposit','conversion','payout','fee','refund','commission','commission_adjustment','settlement','reversal')),
  idempotency_key text NOT NULL UNIQUE,
  order_id uuid REFERENCES orders,
  reverses_journal_id uuid UNIQUE REFERENCES ledger_journals,
  created_by uuid NOT NULL REFERENCES actors,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  CHECK ((kind = 'reversal') = (reverses_journal_id IS NOT NULL)),
  CHECK (reverses_journal_id IS NULL OR reverses_journal_id <> id),
  CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE TABLE ledger_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id uuid NOT NULL REFERENCES ledger_journals,
  line_number integer NOT NULL CHECK (line_number > 0),
  account_id uuid NOT NULL,
  currency text NOT NULL REFERENCES currencies,
  amount exact_amount NOT NULL CHECK (amount <> 0), -- Debit positive, credit negative.
  memo text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (journal_id,line_number),
  FOREIGN KEY (account_id,currency) REFERENCES ledger_accounts (id,currency)
);
CREATE INDEX ledger_entries_by_account ON ledger_entries (account_id,id);

CREATE TABLE commission_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  partner_id uuid NOT NULL,
  rule_version_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('accrual','adjustment')),
  original_event_id uuid REFERENCES commission_events,
  amount exact_amount NOT NULL CHECK (amount <> 0),
  currency text NOT NULL REFERENCES currencies,
  rule_snapshot jsonb NOT NULL,
  ledger_journal_id uuid NOT NULL UNIQUE REFERENCES ledger_journals,
  idempotency_key text NOT NULL UNIQUE,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (order_id,partner_id) REFERENCES order_attributions (order_id,partner_id),
  FOREIGN KEY (rule_version_id,partner_id) REFERENCES commission_rule_versions (id,partner_id),
  CHECK ((event_type = 'accrual' AND amount > 0 AND original_event_id IS NULL)
         OR (event_type = 'adjustment' AND amount < 0 AND original_event_id IS NOT NULL)),
  CHECK (jsonb_typeof(rule_snapshot) = 'object')
);
CREATE UNIQUE INDEX one_commission_accrual_per_order_partner
  ON commission_events (order_id,partner_id) WHERE event_type = 'accrual';

CREATE TABLE monthly_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL REFERENCES partners,
  currency text NOT NULL REFERENCES currencies,
  period date NOT NULL CHECK (extract(day FROM period) = 1),
  total_amount exact_amount NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','approved','paid')),
  maker_id uuid NOT NULL REFERENCES actors,
  checker_id uuid REFERENCES actors,
  approved_at timestamptz,
  paid_at timestamptz,
  ledger_journal_id uuid UNIQUE REFERENCES ledger_journals,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner_id,currency,period),
  CHECK (checker_id IS NULL OR checker_id <> maker_id),
  CHECK (state = 'draft' OR (checker_id IS NOT NULL AND approved_at IS NOT NULL)),
  CHECK (state <> 'paid' OR (paid_at IS NOT NULL AND ledger_journal_id IS NOT NULL AND total_amount > 0))
);

CREATE TABLE settlement_allocations (
  settlement_id uuid NOT NULL REFERENCES monthly_settlements,
  commission_event_id uuid NOT NULL UNIQUE REFERENCES commission_events,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (settlement_id,commission_event_id)
);

CREATE TABLE batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers,
  client_batch_id text NOT NULL,
  payload_sha256 text NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL DEFAULT 'validating'
    CHECK (state IN ('validating','ready','processing','partial','complete','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id,client_batch_id),
  UNIQUE (id,customer_id)
);

CREATE TABLE batch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  client_item_id text NOT NULL,
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
  request jsonb NOT NULL,
  order_id uuid UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','created','rejected')),
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id,client_item_id),
  FOREIGN KEY (batch_id,customer_id) REFERENCES batches (id,customer_id),
  FOREIGN KEY (order_id,customer_id) REFERENCES orders (id,customer_id),
  CHECK ((state = 'created' AND order_id IS NOT NULL) OR (state <> 'created' AND order_id IS NULL)),
  CHECK (state <> 'rejected' OR failure_reason IS NOT NULL)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  dedupe_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','delivered','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'leased' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
         OR (state <> 'leased' AND lease_owner IS NULL AND lease_until IS NULL)),
  CHECK (state <> 'delivered' OR delivered_at IS NOT NULL)
);
CREATE INDEX outbox_ready ON outbox_events (available_at,created_at) WHERE state IN ('pending','leased');

CREATE TABLE reconciliation_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  order_id uuid REFERENCES orders,
  payout_attempt_id uuid REFERENCES payout_attempts,
  refund_id uuid REFERENCES refunds,
  category text NOT NULL CHECK (category IN ('unknown_payout','unknown_refund','deposit_mismatch','duplicate_event','ledger_mismatch','provider_mismatch','late_deposit')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','investigating','resolved')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  assigned_to uuid REFERENCES actors,
  resolved_by uuid REFERENCES actors,
  resolution text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (state <> 'resolved' OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution IS NOT NULL))
);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES actors,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  request_id text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_entity_timeline ON audit_events (entity_type,entity_id,id);

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; write a correction/reversal instead', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['quotes','commission_rule_versions','order_attributions','deposit_transfers','deposit_observations','ledger_accounts','ledger_journals','ledger_entries','commission_events','settlement_allocations','audit_events'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON offramp.%I FOR EACH ROW EXECUTE FUNCTION offramp.reject_mutation()',table_name);
    EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON offramp.%I FOR EACH STATEMENT EXECUTE FUNCTION offramp.reject_mutation()',table_name);
  END LOOP;
END;
$$;

CREATE FUNCTION guard_beneficiary() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.id,NEW.customer_id,NEW.version,NEW.account_fingerprint,NEW.bank_account_ref,NEW.currency,NEW.country_code,NEW.display_name,NEW.bank_name,NEW.created_by)
      IS DISTINCT FROM (OLD.id,OLD.customer_id,OLD.version,OLD.account_fingerprint,OLD.bank_account_ref,OLD.currency,OLD.country_code,OLD.display_name,OLD.bank_name,OLD.created_by) THEN
    -- Versioned beneficiary details are never edited beneath an approved order.
    RAISE EXCEPTION 'Beneficiary details are immutable; create a new version' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'active' AND NOT EXISTS (SELECT 1 FROM actors WHERE id = NEW.approved_by AND kind = 'human' AND enabled) THEN
    RAISE EXCEPTION 'Beneficiary approval requires an enabled human checker' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER beneficiary_guard BEFORE INSERT OR UPDATE ON beneficiaries FOR EACH ROW EXECUTE FUNCTION guard_beneficiary();

CREATE FUNCTION make_beneficiary_snapshot(b beneficiaries) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('beneficiaryId',b.id::text,'version',b.version,'displayName',b.display_name,
    'bankName',b.bank_name,'bankAccountRef',b.bank_account_ref,'accountFingerprint',b.account_fingerprint,
    'currency',b.currency,'countryCode',b.country_code)
$$;

CREATE FUNCTION guard_order() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
DECLARE q quotes%ROWTYPE; b beneficiaries%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO STRICT q FROM quotes WHERE id = NEW.quote_id;
    SELECT * INTO STRICT b FROM beneficiaries WHERE id = NEW.beneficiary_id;
    IF q.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'Quote expired' USING ERRCODE = '23514'; END IF;
    IF b.status <> 'active' OR b.customer_id <> NEW.customer_id OR b.currency <> NEW.payout_currency THEN
      RAISE EXCEPTION 'Beneficiary must be an active whitelist entry for this customer and currency' USING ERRCODE = '23514';
    END IF;
    IF NEW.beneficiary_snapshot <> make_beneficiary_snapshot(b) THEN
      RAISE EXCEPTION 'Beneficiary snapshot differs from approved whitelist version' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM customers WHERE id = NEW.customer_id AND status = 'verified') THEN
      RAISE EXCEPTION 'Customer is not verified' USING ERRCODE = '23514';
    END IF;
    IF (NEW.deposit_currency,NEW.payout_currency,NEW.expected_deposit_amount,NEW.payout_amount)
        IS DISTINCT FROM (q.input_currency,q.output_currency,q.input_amount,q.net_output_amount) THEN
      RAISE EXCEPTION 'Order financial terms differ from immutable quote' USING ERRCODE = '23514';
    END IF;
    IF NEW.deposit_state <> 'awaiting' OR NEW.payout_state <> 'not_ready' OR NEW.received_deposit_amount <> 0 OR NEW.receipt_state <> 'not_available' THEN
      RAISE EXCEPTION 'Order must begin without deposit or payout progress' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.id,NEW.customer_id,NEW.client_order_id,NEW.quote_id,NEW.beneficiary_id,NEW.beneficiary_snapshot,NEW.deposit_currency,NEW.payout_currency,NEW.expected_deposit_amount,NEW.payout_amount,NEW.deposit_address_ref,NEW.created_at)
        IS DISTINCT FROM (OLD.id,OLD.customer_id,OLD.client_order_id,OLD.quote_id,OLD.beneficiary_id,OLD.beneficiary_snapshot,OLD.deposit_currency,OLD.payout_currency,OLD.expected_deposit_amount,OLD.payout_amount,OLD.deposit_address_ref,OLD.created_at) THEN
      RAISE EXCEPTION 'Order financial terms and beneficiary snapshot are immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.payout_state IN ('succeeded','refunded','cancelled') AND NEW.payout_state <> OLD.payout_state THEN
      RAISE EXCEPTION 'Terminal payout state cannot be reopened' USING ERRCODE = '23514';
    END IF;
    NEW.row_version := OLD.row_version + 1;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER order_guard BEFORE INSERT OR UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION guard_order();

CREATE FUNCTION guard_transfer() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
DECLARE o orders%ROWTYPE; previous_state text; expected_number integer;
BEGIN
  -- Every payout/refund starts by locking the same order, serializing opposite directions.
  SELECT * INTO STRICT o FROM orders WHERE id = NEW.order_id FOR UPDATE;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'awaiting_approval' OR NEW.checker_id IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
      RAISE EXCEPTION 'A transfer must begin with a new maker request' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'payout_attempts' THEN
      IF o.deposit_state <> 'confirmed' OR o.received_deposit_amount < o.expected_deposit_amount THEN
        RAISE EXCEPTION 'Payout requires a confirmed, sufficient deposit' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM refunds WHERE order_id = o.id AND state <> 'cancelled') THEN
        RAISE EXCEPTION 'Refund already reserved this order' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM payout_attempts WHERE order_id = o.id AND state NOT IN ('failed','cancelled')) THEN
        RAISE EXCEPTION 'Prior payout is live, uncertain, or successful; reconcile it before retrying' USING ERRCODE = '23514';
      END IF;
      SELECT coalesce(max(attempt_number),0)+1 INTO expected_number FROM payout_attempts WHERE order_id = o.id;
      IF NEW.attempt_number <> expected_number OR NEW.currency <> o.payout_currency OR NEW.amount <> o.payout_amount OR NEW.beneficiary_id <> o.beneficiary_id OR NEW.beneficiary_snapshot <> o.beneficiary_snapshot THEN
        RAISE EXCEPTION 'Payout attempt differs from authorized order or sequence' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF o.deposit_state NOT IN ('confirmed','underpaid','overpaid','late') OR o.received_deposit_amount <= 0 OR NEW.amount <> o.received_deposit_amount OR NEW.currency <> o.deposit_currency THEN
        RAISE EXCEPTION 'MVP refund must return the full observed deposit in its original currency' USING ERRCODE = '23514';
      END IF;
      IF EXISTS (SELECT 1 FROM payout_attempts WHERE order_id = o.id AND state NOT IN ('failed','cancelled')) THEN
        RAISE EXCEPTION 'Payout is live, uncertain, or successful; refund blocked' USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
    IF (NEW.id,NEW.order_id,NEW.idempotency_key,NEW.currency,NEW.amount,NEW.maker_id,NEW.request_sha256,NEW.provider,NEW.created_at)
        IS DISTINCT FROM (OLD.id,OLD.order_id,OLD.idempotency_key,OLD.currency,OLD.amount,OLD.maker_id,OLD.request_sha256,OLD.provider,OLD.created_at) THEN
      RAISE EXCEPTION 'Transfer request identity and financial terms are immutable' USING ERRCODE = '23514';
    END IF;
    IF TG_TABLE_NAME = 'payout_attempts' THEN
      IF (NEW.attempt_number,NEW.beneficiary_id,NEW.beneficiary_snapshot) IS DISTINCT FROM (OLD.attempt_number,OLD.beneficiary_id,OLD.beneficiary_snapshot) THEN
        RAISE EXCEPTION 'Payout destination is immutable' USING ERRCODE = '23514';
      END IF;
      IF OLD.provider_transfer_id IS NOT NULL AND NEW.provider_transfer_id IS DISTINCT FROM OLD.provider_transfer_id THEN
        RAISE EXCEPTION 'Provider transfer identity is immutable' USING ERRCODE = '23514';
      END IF;
    ELSE
      IF (NEW.destination_ref,NEW.reason) IS DISTINCT FROM (OLD.destination_ref,OLD.reason) THEN
        RAISE EXCEPTION 'Refund destination and reason are immutable' USING ERRCODE = '23514';
      END IF;
      IF OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id THEN
        RAISE EXCEPTION 'Provider refund identity is immutable' USING ERRCODE = '23514';
      END IF;
    END IF;
    previous_state := OLD.state;
    IF previous_state <> NEW.state AND NOT (
      (previous_state = 'awaiting_approval' AND NEW.state IN ('approved','cancelled')) OR
      (previous_state = 'approved' AND NEW.state IN ('submitting','cancelled')) OR
      (previous_state = 'submitting' AND NEW.state IN ('processing','unknown','succeeded','failed')) OR
      (previous_state = 'processing' AND NEW.state IN ('unknown','succeeded','failed')) OR
      (previous_state = 'unknown' AND NEW.state IN ('processing','succeeded','failed'))
    ) THEN RAISE EXCEPTION 'Illegal transfer transition: % -> %',previous_state,NEW.state USING ERRCODE = '23514'; END IF;
    IF previous_state = 'unknown' AND NEW.state <> previous_state AND (NEW.evidence IS NULL OR NEW.evidence = '{}'::jsonb) THEN
      RAISE EXCEPTION 'Unknown result requires provider reconciliation evidence' USING ERRCODE = '23514';
    END IF;
    IF OLD.checker_id IS NOT NULL AND (NEW.checker_id,NEW.approved_at) IS DISTINCT FROM (OLD.checker_id,OLD.approved_at) THEN
      RAISE EXCEPTION 'Approval identity and timestamp are immutable' USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := now();
  END IF;
  IF NEW.checker_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM actors WHERE id = NEW.checker_id AND kind = 'human' AND enabled) THEN
    RAISE EXCEPTION 'Transfer approval requires an enabled human checker' USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN ('approved','submitting') AND TG_TABLE_NAME = 'refunds' THEN
    IF EXISTS (SELECT 1 FROM payout_attempts WHERE order_id = o.id AND state NOT IN ('failed','cancelled')) THEN
      RAISE EXCEPTION 'Refund cannot advance while a payout is live or successful' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state IN ('approved','submitting') AND TG_TABLE_NAME = 'payout_attempts' THEN
    IF EXISTS (SELECT 1 FROM refunds WHERE order_id = o.id AND state <> 'cancelled') THEN
      RAISE EXCEPTION 'Payout cannot advance while a refund is reserved' USING ERRCODE = '23514';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM beneficiaries WHERE id = NEW.beneficiary_id AND status = 'active') OR
       NOT EXISTS (SELECT 1 FROM customers WHERE id = o.customer_id AND status = 'verified') THEN
      RAISE EXCEPTION 'Customer or beneficiary is no longer eligible' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payout_guard BEFORE INSERT OR UPDATE ON payout_attempts FOR EACH ROW EXECUTE FUNCTION guard_transfer();
CREATE TRIGGER refund_guard BEFORE INSERT OR UPDATE ON refunds FOR EACH ROW EXECUTE FUNCTION guard_transfer();
CREATE TRIGGER payout_no_delete BEFORE DELETE ON payout_attempts FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER refund_no_delete BEFORE DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION stamp_journal() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
BEGIN
  NEW.created_xid := pg_current_xact_id();
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER journal_stamp BEFORE INSERT ON ledger_journals FOR EACH ROW EXECUTE FUNCTION stamp_journal();

CREATE FUNCTION guard_ledger_entry() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
DECLARE journal_xid xid8; scale smallint;
BEGIN
  SELECT created_xid INTO STRICT journal_xid FROM ledger_journals WHERE id = NEW.journal_id;
  IF journal_xid <> pg_current_xact_id() THEN
    RAISE EXCEPTION 'Committed journals are sealed; create a new journal' USING ERRCODE = '23514';
  END IF;
  SELECT minor_units INTO STRICT scale FROM currencies WHERE code = NEW.currency;
  IF NEW.amount <> round(NEW.amount,scale) THEN
    RAISE EXCEPTION 'Ledger amount exceeds currency precision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER entry_guard BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION guard_ledger_entry();

CREATE FUNCTION enforce_balanced_journal() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
DECLARE journal_id_to_check uuid; target ledger_journals%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'ledger_journals' THEN journal_id_to_check := NEW.id; ELSE journal_id_to_check := NEW.journal_id; END IF;
  SELECT * INTO STRICT target FROM ledger_journals WHERE id = journal_id_to_check;
  IF (SELECT count(*) FROM ledger_entries WHERE journal_id = journal_id_to_check) < 2 OR EXISTS (
    SELECT 1 FROM ledger_entries WHERE journal_id = journal_id_to_check GROUP BY currency HAVING sum(amount) <> 0
  ) THEN RAISE EXCEPTION 'Journal % is empty, single-entry, or unbalanced by currency',journal_id_to_check USING ERRCODE = '23514'; END IF;
  IF target.reverses_journal_id IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM ledger_journals WHERE id = target.reverses_journal_id AND reverses_journal_id IS NOT NULL) THEN
      RAISE EXCEPTION 'Reverse the economic correction with a new journal, not a reversal of a reversal' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      SELECT 1 FROM (
        SELECT account_id,currency,sum(amount) AS amount FROM ledger_entries
        WHERE journal_id = journal_id_to_check GROUP BY account_id,currency
      ) r FULL JOIN (
        SELECT account_id,currency,sum(amount) AS amount FROM ledger_entries
        WHERE journal_id = target.reverses_journal_id GROUP BY account_id,currency
      ) o USING (account_id,currency)
      WHERE coalesce(r.amount,0) <> -coalesce(o.amount,0)
    ) THEN RAISE EXCEPTION 'Reversal must exactly negate original account/currency balances' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER journal_balanced AFTER INSERT ON ledger_journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_balanced_journal();
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_balanced_journal();

CREATE FUNCTION guard_commission() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
DECLARE original commission_events%ROWTYPE; rule commission_rule_versions%ROWTYPE; already_adjusted numeric;
BEGIN
  SELECT * INTO STRICT rule FROM commission_rule_versions WHERE id = NEW.rule_version_id;
  IF NEW.rule_snapshot <> rule.snapshot OR NEW.currency <> rule.currency OR NEW.partner_id <> rule.partner_id THEN
    RAISE EXCEPTION 'Commission differs from immutable rule snapshot' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM order_attributions WHERE order_id = NEW.order_id AND partner_id = NEW.partner_id AND rule_version_id = NEW.rule_version_id) THEN
    RAISE EXCEPTION 'Commission rule differs from order attribution snapshot' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'adjustment' THEN
    SELECT * INTO STRICT original FROM commission_events WHERE id = NEW.original_event_id FOR UPDATE;
    IF original.event_type <> 'accrual' OR (NEW.order_id,NEW.partner_id,NEW.currency,NEW.rule_version_id)
        IS DISTINCT FROM (original.order_id,original.partner_id,original.currency,original.rule_version_id) THEN
      RAISE EXCEPTION 'Adjustment must reference matching original accrual' USING ERRCODE = '23514';
    END IF;
    SELECT coalesce(sum(amount),0) INTO already_adjusted FROM commission_events WHERE original_event_id = original.id;
    IF original.amount + already_adjusted + NEW.amount < 0 THEN
      RAISE EXCEPTION 'Negative adjustments cannot exceed original accrual' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER commission_guard BEFORE INSERT ON commission_events FOR EACH ROW EXECUTE FUNCTION guard_commission();

CREATE FUNCTION enforce_commission_ledger() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
DECLARE liability_total numeric; journal_kind text;
BEGIN
  SELECT kind INTO STRICT journal_kind FROM ledger_journals WHERE id = NEW.ledger_journal_id;
  SELECT coalesce(sum(e.amount),0) INTO liability_total FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
    WHERE e.journal_id = NEW.ledger_journal_id AND a.partner_id = NEW.partner_id AND a.kind = 'liability' AND e.currency = NEW.currency;
  IF liability_total <> -NEW.amount OR journal_kind <> (CASE WHEN NEW.event_type = 'accrual' THEN 'commission' ELSE 'commission_adjustment' END) THEN
    RAISE EXCEPTION 'Commission must be backed by the matching partner liability ledger movement' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER commission_ledger AFTER INSERT ON commission_events
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_commission_ledger();

CREATE FUNCTION guard_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.state <> 'draft' THEN
    RAISE EXCEPTION 'Settlement must start as a draft' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id,NEW.partner_id,NEW.currency,NEW.period,NEW.maker_id,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.partner_id,OLD.currency,OLD.period,OLD.maker_id,OLD.created_at) THEN
      RAISE EXCEPTION 'Settlement identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.state <> 'draft' AND (NEW.total_amount,NEW.checker_id,NEW.approved_at) IS DISTINCT FROM (OLD.total_amount,OLD.checker_id,OLD.approved_at) THEN
      RAISE EXCEPTION 'Approved settlement is sealed' USING ERRCODE = '23514';
    END IF;
    IF OLD.state <> NEW.state AND NOT ((OLD.state = 'draft' AND NEW.state = 'approved') OR (OLD.state = 'approved' AND NEW.state = 'paid')) THEN
      RAISE EXCEPTION 'Illegal settlement transition' USING ERRCODE = '23514';
    END IF;
    IF OLD.state = 'paid' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Paid settlement is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.checker_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM actors WHERE id = NEW.checker_id AND kind = 'human' AND enabled) THEN
    RAISE EXCEPTION 'Settlement approval requires an enabled human checker' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER settlement_guard BEFORE INSERT OR UPDATE ON monthly_settlements FOR EACH ROW EXECUTE FUNCTION guard_settlement();
CREATE TRIGGER settlement_no_delete BEFORE DELETE ON monthly_settlements FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE FUNCTION guard_allocation() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
DECLARE s monthly_settlements%ROWTYPE; c commission_events%ROWTYPE;
BEGIN
  SELECT * INTO STRICT s FROM monthly_settlements WHERE id = NEW.settlement_id FOR UPDATE;
  SELECT * INTO STRICT c FROM commission_events WHERE id = NEW.commission_event_id;
  IF s.state <> 'draft' OR (s.partner_id,s.currency) IS DISTINCT FROM (c.partner_id,c.currency) OR c.created_at >= (s.period + interval '1 month') AT TIME ZONE 'UTC' THEN
    RAISE EXCEPTION 'Settlement allocation requires a draft and eligible partner/currency/period' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER allocation_guard BEFORE INSERT ON settlement_allocations FOR EACH ROW EXECUTE FUNCTION guard_allocation();

CREATE FUNCTION enforce_settlement_total() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
DECLARE settlement_id_to_check uuid; s monthly_settlements%ROWTYPE; allocation_total numeric; liability_total numeric;
BEGIN
  IF TG_TABLE_NAME = 'monthly_settlements' THEN settlement_id_to_check := NEW.id; ELSE settlement_id_to_check := NEW.settlement_id; END IF;
  SELECT * INTO STRICT s FROM monthly_settlements WHERE id = settlement_id_to_check;
  SELECT coalesce(sum(c.amount),0) INTO allocation_total FROM settlement_allocations a JOIN commission_events c ON c.id = a.commission_event_id WHERE a.settlement_id = s.id;
  IF allocation_total <> s.total_amount THEN
    RAISE EXCEPTION 'Settlement total must equal its uniquely allocated commission events' USING ERRCODE = '23514';
  END IF;
  IF s.state = 'paid' THEN
    SELECT coalesce(sum(e.amount),0) INTO liability_total FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE e.journal_id = s.ledger_journal_id AND a.partner_id = s.partner_id AND a.kind = 'liability' AND e.currency = s.currency;
    IF liability_total <> s.total_amount OR NOT EXISTS (SELECT 1 FROM ledger_journals WHERE id = s.ledger_journal_id AND kind = 'settlement') THEN
      RAISE EXCEPTION 'Paid settlement must reduce the matching partner liability in its ledger journal' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER settlement_total AFTER INSERT OR UPDATE ON monthly_settlements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_settlement_total();
CREATE CONSTRAINT TRIGGER allocation_total AFTER INSERT ON settlement_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION enforce_settlement_total();

CREATE FUNCTION protect_event_payload() RETURNS trigger LANGUAGE plpgsql SET search_path = offramp, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'webhook_events' THEN
    IF (NEW.id,NEW.provider,NEW.external_event_id,NEW.payload_sha256,NEW.payload,NEW.signature_verified,NEW.received_at)
        IS DISTINCT FROM (OLD.id,OLD.provider,OLD.external_event_id,OLD.payload_sha256,OLD.payload,OLD.signature_verified,OLD.received_at) THEN
      RAISE EXCEPTION 'Webhook identity and received payload are immutable' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.id,NEW.aggregate_type,NEW.aggregate_id,NEW.event_type,NEW.schema_version,NEW.dedupe_key,NEW.payload,NEW.created_at)
        IS DISTINCT FROM (OLD.id,OLD.aggregate_type,OLD.aggregate_id,OLD.event_type,OLD.schema_version,OLD.dedupe_key,OLD.payload,OLD.created_at) THEN
      RAISE EXCEPTION 'Outbox event identity and payload are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER webhook_payload_guard BEFORE UPDATE ON webhook_events FOR EACH ROW EXECUTE FUNCTION protect_event_payload();
CREATE TRIGGER outbox_payload_guard BEFORE UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION protect_event_payload();
CREATE TRIGGER webhook_no_delete BEFORE DELETE ON webhook_events FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE VIEW ledger_balances AS
  SELECT a.id AS account_id,a.code,a.currency,a.kind,a.customer_id,a.partner_id,coalesce(sum(e.amount),0)::numeric(38,18) AS signed_balance
  FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.account_id = a.id GROUP BY a.id;

COMMENT ON SCHEMA offramp IS 'Mock stablecoin offramp MVP target persistence schema; operational authorization and custody are out of scope.';
COMMENT ON COLUMN ledger_entries.amount IS 'Signed exact amount: debit positive, credit negative. Each journal balances independently in each currency.';
COMMENT ON COLUMN ledger_journals.created_xid IS 'Seals journals after the inserting transaction; applications may not override this stamp.';
COMMENT ON TABLE settlement_allocations IS 'Append-only. Each commission event, including a negative adjustment, can be allocated exactly once.';
COMMIT;
