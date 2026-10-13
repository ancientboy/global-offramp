CREATE SCHEMA IF NOT EXISTS runtime;
CREATE TABLE IF NOT EXISTS runtime.state (id smallint PRIMARY KEY CHECK(id=1),version bigint NOT NULL DEFAULT 0,document jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS runtime.journals (id uuid PRIMARY KEY,business_key text UNIQUE NOT NULL,reversal_of uuid UNIQUE REFERENCES runtime.journals(id),created_at timestamptz NOT NULL,created_tx bigint NOT NULL DEFAULT txid_current());
CREATE TABLE IF NOT EXISTS runtime.ledger_lines (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,journal_id uuid NOT NULL REFERENCES runtime.journals(id),account text NOT NULL,currency text NOT NULL CHECK(currency IN('USDT','USDC','CNY','USD')),debit numeric(38,18) NOT NULL DEFAULT 0,credit numeric(38,18) NOT NULL DEFAULT 0,CHECK((debit>0 AND credit=0) OR (credit>0 AND debit=0)),CHECK(debit=round(debit,CASE WHEN currency IN('USD','CNY') THEN 2 ELSE 6 END) AND credit=round(credit,CASE WHEN currency IN('USD','CNY') THEN 2 ELSE 6 END)));
CREATE TABLE IF NOT EXISTS runtime.audit (id uuid PRIMARY KEY,actor_id text NOT NULL,action text NOT NULL,target_id text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS runtime.outbox (id uuid PRIMARY KEY,topic text NOT NULL,aggregate_id text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL,delivered_at timestamptz);
CREATE INDEX IF NOT EXISTS outbox_pending ON runtime.outbox(created_at) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS runtime.consumer_events (event_id uuid PRIMARY KEY REFERENCES runtime.outbox(id),processed_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION runtime.deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'append-only record'; END; $$;
DROP TRIGGER IF EXISTS ledger_immutable ON runtime.ledger_lines;
CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON runtime.ledger_lines FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
DROP TRIGGER IF EXISTS journal_immutable ON runtime.journals;
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON runtime.journals FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
DROP TRIGGER IF EXISTS audit_immutable ON runtime.audit;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON runtime.audit FOR EACH ROW EXECUTE FUNCTION runtime.deny_mutation();
CREATE OR REPLACE FUNCTION runtime.ensure_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal uuid; BEGIN
 IF TG_TABLE_NAME='journals' THEN journal:=NEW.id; ELSE journal:=NEW.journal_id; END IF;
 IF (SELECT count(*) FROM runtime.ledger_lines WHERE journal_id=journal)<2 OR EXISTS(SELECT 1 FROM runtime.ledger_lines WHERE journal_id=journal GROUP BY currency HAVING sum(debit-credit)<>0) THEN RAISE EXCEPTION 'journal % not balanced by currency',journal; END IF;
 IF EXISTS (SELECT 1 FROM runtime.journals WHERE id=journal AND reversal_of IS NOT NULL) AND EXISTS ( (SELECT account,currency,debit,credit FROM runtime.ledger_lines WHERE journal_id=journal EXCEPT ALL SELECT account,currency,credit,debit FROM runtime.ledger_lines WHERE journal_id=(SELECT reversal_of FROM runtime.journals WHERE id=journal)) UNION ALL (SELECT account,currency,credit,debit FROM runtime.ledger_lines WHERE journal_id=(SELECT reversal_of FROM runtime.journals WHERE id=journal) EXCEPT ALL SELECT account,currency,debit,credit FROM runtime.ledger_lines WHERE journal_id=journal)) THEN RAISE EXCEPTION 'reversal does not exactly negate original'; END IF;
 RETURN NULL;
END; $$;
DROP TRIGGER IF EXISTS journal_balance ON runtime.journals;
CREATE CONSTRAINT TRIGGER journal_balance AFTER INSERT ON runtime.journals DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION runtime.ensure_balanced();
DROP TRIGGER IF EXISTS lines_balance ON runtime.ledger_lines;
CREATE CONSTRAINT TRIGGER lines_balance AFTER INSERT ON runtime.ledger_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION runtime.ensure_balanced();
-- Application role must not own these tables or be superuser. Deployment must revoke DDL,
-- UPDATE/DELETE/TRUNCATE on ledger/audit and use a separate migration role. See runbook.

CREATE OR REPLACE FUNCTION runtime.require_open_journal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT created_tx FROM runtime.journals WHERE id=NEW.journal_id) IS DISTINCT FROM txid_current() THEN RAISE EXCEPTION 'committed journal is sealed'; END IF; RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS ledger_sealed ON runtime.ledger_lines;
CREATE TRIGGER ledger_sealed BEFORE INSERT ON runtime.ledger_lines FOR EACH ROW EXECUTE FUNCTION runtime.require_open_journal();
