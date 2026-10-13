-- Run after 001_core.sql: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/invariants.sql
-- Every fixture and helper is rolled back. Unexpected SQLSTATE or a missing rejection fails the run.
BEGIN;
SET search_path = offramp, public;
CREATE TEMP TABLE invariant_results (label text PRIMARY KEY, passed boolean NOT NULL);
CREATE FUNCTION pg_temp.test_id(label text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5(label)::uuid $$;
CREATE FUNCTION pg_temp.assert_true(condition boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: %',label; END IF;
  INSERT INTO invariant_results VALUES (label,true);
END;
$$;
CREATE FUNCTION pg_temp.expect_error(command text,expected_state text,label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_state text;
BEGIN
  BEGIN
    EXECUTE command;
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE;
    IF actual_state <> expected_state THEN
      RAISE EXCEPTION 'Wrong SQLSTATE for %: expected %, got % (%)',label,expected_state,actual_state,SQLERRM;
    END IF;
  END;
  IF actual_state IS NULL THEN RAISE EXCEPTION 'Expected rejection did not occur: %',label; END IF;
  SET CONSTRAINTS ALL DEFERRED;
  INSERT INTO invariant_results VALUES (label,true);
END;
$$;

INSERT INTO actors (id,subject,kind,display_name) VALUES
  (pg_temp.test_id('maker'),'test-maker','human','Test maker'),
  (pg_temp.test_id('checker'),'test-checker','human','Test checker'),
  (pg_temp.test_id('service'),'test-service','service','Test service');
INSERT INTO customers (id,account_type,display_name,external_subject,status,country_code) VALUES
  (pg_temp.test_id('customer'),'company','Demo company','test-customer','verified','US'),
  (pg_temp.test_id('other_customer'),'personal','Other customer','test-other','verified','US');
INSERT INTO beneficiaries (id,customer_id,display_name,bank_name,bank_account_ref,account_fingerprint,currency,country_code,status,created_by,approved_by,approved_at) VALUES
  (pg_temp.test_id('beneficiary'),pg_temp.test_id('customer'),'Demo recipient','Mock Bank','mock:recipient','mock:fingerprint','USD','US','active',pg_temp.test_id('maker'),pg_temp.test_id('checker'),now());

SELECT pg_temp.assert_true((SELECT minor_units = 2 FROM currencies WHERE code = 'CNY'),'mainland CNY accounting currency has two minor units');
SELECT pg_temp.assert_true(0.1::exact_amount + 0.2::exact_amount = 0.3::exact_amount,'exact decimal arithmetic');
SELECT pg_temp.expect_error($cmd$ SELECT 'NaN'::exact_amount $cmd$,'23514','NaN is rejected');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO beneficiaries (customer_id,display_name,bank_name,bank_account_ref,account_fingerprint,currency,country_code,status,created_by,approved_by,approved_at)
  VALUES (pg_temp.test_id('customer'),'Invalid','Mock','mock:bad','mock:bad','USD','US','active',pg_temp.test_id('maker'),pg_temp.test_id('maker'),now())
$cmd$,'23514','whitelist approval requires different identities');
SELECT pg_temp.expect_error($cmd$ UPDATE beneficiaries SET bank_account_ref = 'mock:changed' WHERE id = pg_temp.test_id('beneficiary') $cmd$,'23514','beneficiary destination is immutable');

INSERT INTO quotes (id,customer_id,version,input_currency,output_currency,input_amount,rate,gross_output_amount,fee_amount,net_output_amount,snapshot,expires_at)
SELECT pg_temp.test_id('quote-' || name),pg_temp.test_id('customer'),1,'USDT','USD',100,1,100,2,98,'{"version":1,"inputAmount":"100","rate":"1","grossOutputAmount":"100","feeAmount":"2","netOutputAmount":"98"}',now()+interval '1 hour'
FROM unnest(ARRAY['main','refund','commission','batch','mismatch']) AS names(name);
INSERT INTO orders (id,customer_id,client_order_id,quote_id,beneficiary_id,beneficiary_snapshot,deposit_currency,payout_currency,expected_deposit_amount,payout_amount,deposit_address_ref)
SELECT pg_temp.test_id('order-' || name),pg_temp.test_id('customer'),'client-' || name,pg_temp.test_id('quote-' || name),pg_temp.test_id('beneficiary'),(SELECT make_beneficiary_snapshot(b) FROM beneficiaries b WHERE b.id = pg_temp.test_id('beneficiary')),'USDT','USD',100,98,'mock:deposit:' || name
FROM unnest(ARRAY['main','refund','commission','batch']) AS names(name);

SELECT pg_temp.expect_error($cmd$ UPDATE quotes SET rate = 2 WHERE id = pg_temp.test_id('quote-main') $cmd$,'23514','quote snapshot is immutable');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO orders (customer_id,client_order_id,quote_id,beneficiary_id,beneficiary_snapshot,deposit_currency,payout_currency,expected_deposit_amount,payout_amount,deposit_address_ref)
  VALUES (pg_temp.test_id('customer'),'wrong-amount',pg_temp.test_id('quote-mismatch'),pg_temp.test_id('beneficiary'),'{}','USDT','USD',100,99,'mock:wrong')
$cmd$,'23514','order must match frozen quote amounts');
SELECT pg_temp.expect_error($cmd$ UPDATE orders SET payout_amount = 99 WHERE id = pg_temp.test_id('order-main') $cmd$,'23514','order amount cannot drift');
SELECT pg_temp.expect_error($cmd$ UPDATE orders SET payout_state = 'ready' WHERE id = pg_temp.test_id('order-main') $cmd$,'23514','payout cannot become ready before sufficient deposit');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO payout_attempts (order_id,attempt_number,provider,idempotency_key,request_sha256,beneficiary_id,beneficiary_snapshot,currency,amount,maker_id)
  SELECT id,1,'mock','premature',repeat('a',64),beneficiary_id,beneficiary_snapshot,payout_currency,payout_amount,pg_temp.test_id('maker') FROM orders WHERE id = pg_temp.test_id('order-main')
$cmd$,'23514','transfer cannot begin before confirmed deposit');
UPDATE orders SET deposit_state = 'confirmed',received_deposit_amount = 100,payout_state = 'ready';
INSERT INTO payout_attempts (id,order_id,attempt_number,provider,idempotency_key,request_sha256,beneficiary_id,beneficiary_snapshot,currency,amount,maker_id)
SELECT pg_temp.test_id('attempt-main-1'),id,1,'mock','main-payout-1',repeat('a',64),beneficiary_id,beneficiary_snapshot,payout_currency,payout_amount,pg_temp.test_id('maker') FROM orders WHERE id = pg_temp.test_id('order-main');
SELECT pg_temp.expect_error($cmd$ UPDATE payout_attempts SET state = 'approved',checker_id = maker_id,approved_at = now() WHERE id = pg_temp.test_id('attempt-main-1') $cmd$,'23514','payout maker cannot be checker');
SELECT pg_temp.expect_error($cmd$ UPDATE payout_attempts SET state = 'approved',checker_id = pg_temp.test_id('service'),approved_at = now() WHERE id = pg_temp.test_id('attempt-main-1') $cmd$,'23514','service actor cannot approve payout');
SELECT pg_temp.expect_error($cmd$ UPDATE payout_attempts SET state = 'submitting' WHERE id = pg_temp.test_id('attempt-main-1') $cmd$,'23514','payout cannot skip approval');
UPDATE payout_attempts SET state = 'approved',checker_id = pg_temp.test_id('checker'),approved_at = now() WHERE id = pg_temp.test_id('attempt-main-1');
UPDATE payout_attempts SET state = 'submitting' WHERE id = pg_temp.test_id('attempt-main-1');
UPDATE payout_attempts SET state = 'unknown' WHERE id = pg_temp.test_id('attempt-main-1');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO payout_attempts (order_id,attempt_number,provider,idempotency_key,request_sha256,beneficiary_id,beneficiary_snapshot,currency,amount,maker_id)
  SELECT id,2,'mock','unsafe-retry',repeat('b',64),beneficiary_id,beneficiary_snapshot,payout_currency,payout_amount,pg_temp.test_id('maker') FROM orders WHERE id = pg_temp.test_id('order-main')
$cmd$,'23514','unknown payout blocks another attempt');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO refunds (order_id,idempotency_key,currency,amount,destination_ref,request_sha256,reason,maker_id,provider)
  VALUES (pg_temp.test_id('order-main'),'unsafe-refund','USDT',100,'mock:sender',repeat('c',64),'test',pg_temp.test_id('maker'),'mock')
$cmd$,'23514','unknown payout blocks refund');
SELECT pg_temp.expect_error($cmd$ UPDATE payout_attempts SET state = 'cancelled' WHERE id = pg_temp.test_id('attempt-main-1') $cmd$,'23514','unknown payout cannot be cancelled to enable retry');
SELECT pg_temp.expect_error($cmd$ UPDATE payout_attempts SET state = 'failed',definitive_failure = true WHERE id = pg_temp.test_id('attempt-main-1') $cmd$,'23514','unknown payout requires reconciliation evidence');
UPDATE payout_attempts SET state = 'failed',definitive_failure = true,evidence = '{"providerQuery":"definitively_not_sent"}' WHERE id = pg_temp.test_id('attempt-main-1');
INSERT INTO payout_attempts (id,order_id,attempt_number,provider,idempotency_key,request_sha256,beneficiary_id,beneficiary_snapshot,currency,amount,maker_id)
SELECT pg_temp.test_id('attempt-main-2'),id,2,'mock','main-payout-2',repeat('b',64),beneficiary_id,beneficiary_snapshot,payout_currency,payout_amount,pg_temp.test_id('maker') FROM orders WHERE id = pg_temp.test_id('order-main');
UPDATE payout_attempts SET state = 'approved',checker_id = pg_temp.test_id('checker'),approved_at = now() WHERE id = pg_temp.test_id('attempt-main-2');
UPDATE payout_attempts SET state = 'submitting' WHERE id = pg_temp.test_id('attempt-main-2');
UPDATE payout_attempts SET state = 'succeeded',provider_transfer_id = 'mock-transfer-success' WHERE id = pg_temp.test_id('attempt-main-2');
SELECT pg_temp.assert_true((SELECT count(*) = 2 FROM payout_attempts WHERE order_id = pg_temp.test_id('order-main')),'definitive failure permits exactly one next attempt');
SELECT pg_temp.expect_error($cmd$ UPDATE payout_attempts SET state = 'unknown' WHERE id = pg_temp.test_id('attempt-main-2') $cmd$,'23514','successful payout is terminal');
SELECT pg_temp.expect_error($cmd$ UPDATE payout_attempts SET amount = 1 WHERE id = pg_temp.test_id('attempt-main-2') $cmd$,'23514','payout amount immutable');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO payout_attempts (order_id,attempt_number,provider,idempotency_key,request_sha256,beneficiary_id,beneficiary_snapshot,currency,amount,maker_id)
  SELECT id,3,'mock','after-success',repeat('b',64),beneficiary_id,beneficiary_snapshot,payout_currency,payout_amount,pg_temp.test_id('maker') FROM orders WHERE id = pg_temp.test_id('order-main')
$cmd$,'23514','successful payout blocks another attempt');

INSERT INTO refunds (id,order_id,idempotency_key,currency,amount,destination_ref,request_sha256,reason,maker_id,provider)
VALUES (pg_temp.test_id('refund'),pg_temp.test_id('order-refund'),'refund-1','USDT',100,'mock:sender',repeat('c',64),'customer cancellation',pg_temp.test_id('maker'),'mock');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO refunds (order_id,idempotency_key,currency,amount,destination_ref,request_sha256,reason,maker_id,provider)
  VALUES (pg_temp.test_id('order-refund'),'refund-1','USDT',100,'mock:sender',repeat('c',64),'test',pg_temp.test_id('maker'),'mock')
$cmd$,'23505','refund key and order are idempotent');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO payout_attempts (order_id,attempt_number,provider,idempotency_key,request_sha256,beneficiary_id,beneficiary_snapshot,currency,amount,maker_id)
  SELECT id,1,'mock','after-refund',repeat('a',64),beneficiary_id,beneficiary_snapshot,payout_currency,payout_amount,pg_temp.test_id('maker') FROM orders WHERE id = pg_temp.test_id('order-refund')
$cmd$,'23514','refund reservation blocks payout');
SELECT pg_temp.expect_error($cmd$ UPDATE refunds SET state = 'approved',checker_id = maker_id,approved_at = now() WHERE id = pg_temp.test_id('refund') $cmd$,'23514','refund maker cannot be checker');
UPDATE refunds SET state = 'approved',checker_id = pg_temp.test_id('checker'),approved_at = now() WHERE id = pg_temp.test_id('refund');
UPDATE refunds SET state = 'submitting' WHERE id = pg_temp.test_id('refund');
UPDATE refunds SET state = 'unknown' WHERE id = pg_temp.test_id('refund');
SELECT pg_temp.expect_error($cmd$ UPDATE refunds SET state = 'cancelled' WHERE id = pg_temp.test_id('refund') $cmd$,'23514','unknown refund cannot be reopened or cancelled');

INSERT INTO ledger_accounts (id,code,currency,kind) VALUES
  (pg_temp.test_id('cash-usd'),'test.cash.usd','USD','asset'),
  (pg_temp.test_id('revenue-usd'),'test.revenue.usd','USD','revenue'),
  (pg_temp.test_id('cash-eur'),'test.cash.eur','EUR','asset'),
  (pg_temp.test_id('expense-usd'),'test.expense.usd','USD','expense');
INSERT INTO ledger_journals (id,kind,idempotency_key,created_by)
VALUES (pg_temp.test_id('journal-balanced'),'fee','journal-balanced',pg_temp.test_id('maker'));
INSERT INTO ledger_entries (journal_id,line_number,account_id,currency,amount) VALUES
  (pg_temp.test_id('journal-balanced'),1,pg_temp.test_id('cash-usd'),'USD',100),
  (pg_temp.test_id('journal-balanced'),2,pg_temp.test_id('revenue-usd'),'USD',-100);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.assert_true((SELECT signed_balance = 100 FROM ledger_balances WHERE code = 'test.cash.usd'),'balanced journal contributes to account balance');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO ledger_journals (id,kind,idempotency_key,created_by) VALUES (pg_temp.test_id('empty-journal'),'fee','empty-journal',pg_temp.test_id('maker'))
$cmd$,'23514','empty journal fails deferred balance check');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO ledger_journals (id,kind,idempotency_key,created_by) VALUES (pg_temp.test_id('unbalanced'),'fee','unbalanced',pg_temp.test_id('maker'));
  INSERT INTO ledger_entries (journal_id,line_number,account_id,currency,amount) VALUES
    (pg_temp.test_id('unbalanced'),1,pg_temp.test_id('cash-usd'),'USD',100),
    (pg_temp.test_id('unbalanced'),2,pg_temp.test_id('revenue-usd'),'USD',-99)
$cmd$,'23514','unbalanced journal fails at deferred constraint boundary');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO ledger_journals (id,kind,idempotency_key,created_by) VALUES (pg_temp.test_id('cross-currency'),'conversion','cross-currency',pg_temp.test_id('maker'));
  INSERT INTO ledger_entries (journal_id,line_number,account_id,currency,amount) VALUES
    (pg_temp.test_id('cross-currency'),1,pg_temp.test_id('cash-usd'),'USD',100),
    (pg_temp.test_id('cross-currency'),2,pg_temp.test_id('cash-eur'),'EUR',-100)
$cmd$,'23514','cross currency amounts cannot net against one another');
SELECT pg_temp.expect_error($cmd$ UPDATE ledger_entries SET amount = 1 WHERE journal_id = pg_temp.test_id('journal-balanced') $cmd$,'23514','ledger entry update forbidden');
SELECT pg_temp.expect_error($cmd$ DELETE FROM ledger_journals WHERE id = pg_temp.test_id('journal-balanced') $cmd$,'23514','ledger journal delete forbidden');
SELECT pg_temp.expect_error($cmd$ TRUNCATE ledger_entries $cmd$,'23514','ledger truncate forbidden');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO ledger_entries (journal_id,line_number,account_id,currency,amount) VALUES (pg_temp.test_id('journal-balanced'),3,pg_temp.test_id('cash-usd'),'USD',0.001)
$cmd$,'23514','currency minor units are enforced on ledger');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO ledger_journals (id,kind,idempotency_key,created_by,reverses_journal_id) VALUES (pg_temp.test_id('bad-reversal'),'reversal','bad-reversal',pg_temp.test_id('maker'),pg_temp.test_id('journal-balanced'));
  INSERT INTO ledger_entries (journal_id,line_number,account_id,currency,amount) VALUES
    (pg_temp.test_id('bad-reversal'),1,pg_temp.test_id('cash-usd'),'USD',-99),
    (pg_temp.test_id('bad-reversal'),2,pg_temp.test_id('revenue-usd'),'USD',99)
$cmd$,'23514','balanced but incomplete reversal is rejected');
INSERT INTO ledger_journals (id,kind,idempotency_key,created_by,reverses_journal_id)
VALUES (pg_temp.test_id('reversal'),'reversal','valid-reversal',pg_temp.test_id('maker'),pg_temp.test_id('journal-balanced'));
INSERT INTO ledger_entries (journal_id,line_number,account_id,currency,amount) VALUES
  (pg_temp.test_id('reversal'),1,pg_temp.test_id('cash-usd'),'USD',-100),
  (pg_temp.test_id('reversal'),2,pg_temp.test_id('revenue-usd'),'USD',100);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.assert_true((SELECT signed_balance = 0 FROM ledger_balances WHERE code = 'test.cash.usd'),'exact reversal restores original account balances');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO ledger_journals (kind,idempotency_key,created_by,reverses_journal_id) VALUES ('reversal','duplicate-reversal',pg_temp.test_id('maker'),pg_temp.test_id('journal-balanced'))
$cmd$,'23505','original journal can only be reversed once');

INSERT INTO partners (id,code,display_name) VALUES (pg_temp.test_id('partner'),'test-partner','Demo partner');
INSERT INTO commission_rule_versions (id,partner_id,version,basis,rate,currency,snapshot)
VALUES (pg_temp.test_id('rule'),pg_temp.test_id('partner'),1,'fee',0.1,'USD','{"version":1,"basis":"fee","rate":"0.1"}');
INSERT INTO order_attributions (order_id,partner_id,rule_version_id,source,snapshot)
VALUES (pg_temp.test_id('order-commission'),pg_temp.test_id('partner'),pg_temp.test_id('rule'),'test-referral','{"version":1,"partner":"test-partner"}');
INSERT INTO ledger_accounts (id,code,currency,kind,partner_id)
VALUES (pg_temp.test_id('partner-payable'),'test.partner.payable','USD','liability',pg_temp.test_id('partner'));
INSERT INTO ledger_journals (id,kind,idempotency_key,created_by) VALUES
  (pg_temp.test_id('commission-journal'),'commission','commission-journal',pg_temp.test_id('maker')),
  (pg_temp.test_id('adjustment-journal'),'commission_adjustment','adjustment-journal',pg_temp.test_id('maker'));
INSERT INTO ledger_entries (journal_id,line_number,account_id,currency,amount) VALUES
  (pg_temp.test_id('commission-journal'),1,pg_temp.test_id('expense-usd'),'USD',0.2),
  (pg_temp.test_id('commission-journal'),2,pg_temp.test_id('partner-payable'),'USD',-0.2),
  (pg_temp.test_id('adjustment-journal'),1,pg_temp.test_id('expense-usd'),'USD',-0.05),
  (pg_temp.test_id('adjustment-journal'),2,pg_temp.test_id('partner-payable'),'USD',0.05);
INSERT INTO commission_events (id,order_id,partner_id,rule_version_id,event_type,amount,currency,rule_snapshot,ledger_journal_id,idempotency_key,reason)
VALUES (pg_temp.test_id('accrual'),pg_temp.test_id('order-commission'),pg_temp.test_id('partner'),pg_temp.test_id('rule'),'accrual',0.2,'USD','{"version":1,"basis":"fee","rate":"0.1"}',pg_temp.test_id('commission-journal'),'accrual','fee commission');
INSERT INTO commission_events (id,order_id,partner_id,rule_version_id,event_type,original_event_id,amount,currency,rule_snapshot,ledger_journal_id,idempotency_key,reason)
VALUES (pg_temp.test_id('adjustment'),pg_temp.test_id('order-commission'),pg_temp.test_id('partner'),pg_temp.test_id('rule'),'adjustment',pg_temp.test_id('accrual'),-0.05,'USD','{"version":1,"basis":"fee","rate":"0.1"}',pg_temp.test_id('adjustment-journal'),'adjustment','partial fee correction');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.assert_true((SELECT signed_balance = -0.15 FROM ledger_balances WHERE code = 'test.partner.payable'),'negative commission adjustment reduces partner liability');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO ledger_journals (id,kind,idempotency_key,created_by) VALUES (pg_temp.test_id('wrong-commission-journal'),'commission_adjustment','wrong-commission-journal',pg_temp.test_id('maker'));
  INSERT INTO ledger_entries (journal_id,line_number,account_id,currency,amount) VALUES
    (pg_temp.test_id('wrong-commission-journal'),1,pg_temp.test_id('expense-usd'),'USD',-0.01),
    (pg_temp.test_id('wrong-commission-journal'),2,pg_temp.test_id('partner-payable'),'USD',0.01);
  INSERT INTO commission_events (order_id,partner_id,rule_version_id,event_type,original_event_id,amount,currency,rule_snapshot,ledger_journal_id,idempotency_key,reason)
  VALUES (pg_temp.test_id('order-commission'),pg_temp.test_id('partner'),pg_temp.test_id('rule'),'adjustment',pg_temp.test_id('accrual'),-0.02,'USD','{"version":1,"basis":"fee","rate":"0.1"}',pg_temp.test_id('wrong-commission-journal'),'wrong-backing','invalid backing')
$cmd$,'23514','commission adjustment must match its ledger liability movement');
SELECT pg_temp.expect_error($cmd$ UPDATE commission_events SET amount = 0.3 WHERE id = pg_temp.test_id('accrual') $cmd$,'23514','commission history is immutable');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO commission_events (order_id,partner_id,rule_version_id,event_type,original_event_id,amount,currency,rule_snapshot,ledger_journal_id,idempotency_key,reason)
  VALUES (pg_temp.test_id('order-commission'),pg_temp.test_id('partner'),pg_temp.test_id('rule'),'adjustment',pg_temp.test_id('accrual'),-1,'USD','{"version":1,"basis":"fee","rate":"0.1"}',pg_temp.test_id('adjustment-journal'),'over-adjustment','invalid')
$cmd$,'23514','commission cannot be adjusted below zero lifetime accrual');
SELECT pg_temp.expect_error($cmd$ UPDATE commission_rule_versions SET rate = 0.2 WHERE id = pg_temp.test_id('rule') $cmd$,'23514','commission rule versions are immutable');

INSERT INTO monthly_settlements (id,partner_id,currency,period,total_amount,maker_id)
VALUES (pg_temp.test_id('settlement'),pg_temp.test_id('partner'),'USD',date_trunc('month',now() AT TIME ZONE 'UTC')::date,0.15,pg_temp.test_id('maker'));
INSERT INTO settlement_allocations (settlement_id,commission_event_id) VALUES
  (pg_temp.test_id('settlement'),pg_temp.test_id('accrual')),
  (pg_temp.test_id('settlement'),pg_temp.test_id('adjustment'));
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.expect_error($cmd$ UPDATE monthly_settlements SET total_amount = 0.2 WHERE id = pg_temp.test_id('settlement') $cmd$,'23514','settlement total includes negative adjustments');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO settlement_allocations (settlement_id,commission_event_id) VALUES (pg_temp.test_id('settlement'),pg_temp.test_id('accrual'))
$cmd$,'23505','commission can only be allocated once');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO monthly_settlements (partner_id,currency,period,maker_id) VALUES (pg_temp.test_id('partner'),'USD',date_trunc('month',now() AT TIME ZONE 'UTC')::date,pg_temp.test_id('maker'))
$cmd$,'23505','partner currency month settlement is unique');
SELECT pg_temp.expect_error($cmd$ UPDATE monthly_settlements SET state = 'approved',checker_id = maker_id,approved_at = now() WHERE id = pg_temp.test_id('settlement') $cmd$,'23514','settlement maker cannot be checker');
UPDATE monthly_settlements SET state = 'approved',checker_id = pg_temp.test_id('checker'),approved_at = now() WHERE id = pg_temp.test_id('settlement');
SELECT pg_temp.expect_error($cmd$ UPDATE monthly_settlements SET total_amount = 0 WHERE id = pg_temp.test_id('settlement') $cmd$,'23514','approved settlement cannot change amount');

SELECT pg_temp.expect_error($cmd$
  INSERT INTO ledger_journals (id,kind,idempotency_key,created_by) VALUES (pg_temp.test_id('wrong-settlement-journal'),'settlement','wrong-settlement-journal',pg_temp.test_id('maker'));
  INSERT INTO ledger_entries (journal_id,line_number,account_id,currency,amount) VALUES
    (pg_temp.test_id('wrong-settlement-journal'),1,pg_temp.test_id('expense-usd'),'USD',0.15),
    (pg_temp.test_id('wrong-settlement-journal'),2,pg_temp.test_id('cash-usd'),'USD',-0.15);
  UPDATE monthly_settlements SET state = 'paid',paid_at = now(),ledger_journal_id = pg_temp.test_id('wrong-settlement-journal') WHERE id = pg_temp.test_id('settlement')
$cmd$,'23514','paid settlement must release partner liability');

INSERT INTO webhook_events (id,provider,external_event_id,payload_sha256,payload,signature_verified)
VALUES (pg_temp.test_id('webhook'),'mock','event-1',repeat('d',64),'{"event":"deposit"}',true);
SELECT pg_temp.expect_error($cmd$
  INSERT INTO webhook_events (provider,external_event_id,payload_sha256,payload,signature_verified) VALUES ('mock','event-1',repeat('e',64),'{}',true)
$cmd$,'23505','webhook event id deduplicates even changed payload');
SELECT pg_temp.expect_error($cmd$ UPDATE webhook_events SET payload = '{}' WHERE id = pg_temp.test_id('webhook') $cmd$,'23514','received webhook payload cannot be changed');
INSERT INTO batches (id,customer_id,client_batch_id,payload_sha256) VALUES
  (pg_temp.test_id('batch-1'),pg_temp.test_id('customer'),'batch-1',repeat('a',64)),
  (pg_temp.test_id('batch-2'),pg_temp.test_id('customer'),'batch-2',repeat('b',64));
INSERT INTO batch_items (batch_id,customer_id,client_item_id,request_sha256,request,order_id,state)
VALUES (pg_temp.test_id('batch-1'),pg_temp.test_id('customer'),'external-item-1',repeat('a',64),'{}',pg_temp.test_id('order-batch'),'created');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO batch_items (batch_id,customer_id,client_item_id,request_sha256,request)
  VALUES (pg_temp.test_id('batch-2'),pg_temp.test_id('customer'),'external-item-1',repeat('a',64),'{}')
$cmd$,'23505','batch item client ids deduplicate across batches');

INSERT INTO outbox_events (id,aggregate_type,aggregate_id,event_type,schema_version,dedupe_key,payload)
VALUES (pg_temp.test_id('outbox'),'order',pg_temp.test_id('order-main'),'payout.succeeded',1,'outbox-1','{"amount":"98.00"}');
SELECT pg_temp.expect_error($cmd$ UPDATE outbox_events SET payload = '{}' WHERE id = pg_temp.test_id('outbox') $cmd$,'23514','outbox business payload immutable');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,schema_version,dedupe_key,payload)
  VALUES ('order',pg_temp.test_id('order-main'),'payout.succeeded',1,'outbox-1','{}')
$cmd$,'23505','outbox logical events are unique');
SAVEPOINT rollback_outbox;
INSERT INTO outbox_events (aggregate_type,aggregate_id,event_type,schema_version,dedupe_key,payload)
VALUES ('order',pg_temp.test_id('order-main'),'test.rollback',1,'outbox-rollback','{}');
UPDATE orders SET receipt_state = 'pending' WHERE id = pg_temp.test_id('order-main');
ROLLBACK TO rollback_outbox;
SELECT pg_temp.assert_true(NOT EXISTS (SELECT 1 FROM outbox_events WHERE dedupe_key = 'outbox-rollback'),'outbox insert rolls back with business mutation');
SELECT pg_temp.assert_true((SELECT receipt_state = 'not_available' FROM orders WHERE id = pg_temp.test_id('order-main')),'business mutation rolls back with outbox');

INSERT INTO deposit_transfers (id,order_id,network,transaction_hash,currency,amount)
VALUES (pg_temp.test_id('deposit-transfer'),pg_temp.test_id('order-main'),'mock-chain','mock-tx-1','USDT',100);
INSERT INTO deposit_observations (order_id,webhook_event_id,network,transaction_hash,currency,amount,confirmations,required_confirmations,observed_at)
VALUES (pg_temp.test_id('order-main'),pg_temp.test_id('webhook'),'mock-chain','mock-tx-1','USDT',100,12,12,now());
SELECT pg_temp.expect_error($cmd$
  INSERT INTO deposit_transfers (order_id,network,transaction_hash,currency,amount)
  VALUES (pg_temp.test_id('order-refund'),'mock-chain','mock-tx-1','USDT',100)
$cmd$,'23505','chain output can only belong to one order');
INSERT INTO webhook_events (id,provider,external_event_id,payload_sha256,payload,signature_verified)
VALUES (pg_temp.test_id('webhook-2'),'mock','event-2',repeat('f',64),'{}',true);
SELECT pg_temp.expect_error($cmd$
  INSERT INTO deposit_observations (order_id,webhook_event_id,network,transaction_hash,event_index,currency,amount,confirmations,required_confirmations,observed_at)
  VALUES (pg_temp.test_id('order-refund'),pg_temp.test_id('webhook-2'),'mock-chain','mock-tx-1',0,'USDT',100,13,12,now())
$cmd$,'23503','confirmation updates cannot reassign deposit ownership');
SELECT pg_temp.expect_error($cmd$
  INSERT INTO quotes (customer_id,version,input_currency,output_currency,input_amount,rate,gross_output_amount,fee_amount,net_output_amount,snapshot,expires_at)
  VALUES (pg_temp.test_id('customer'),1,'USDT','USD',100,1,100,2,98,'{"version":1,"inputAmount":100,"rate":"1","grossOutputAmount":"100","feeAmount":"2","netOutputAmount":"98"}',now()+interval '1 hour')
$cmd$,'23514','JSON financial amounts must be decimal strings matching normalized values');

UPDATE orders SET payout_state = 'succeeded',receipt_state = 'failed' WHERE id = pg_temp.test_id('order-main');
SELECT pg_temp.assert_true((SELECT payout_state = 'succeeded' AND receipt_state = 'failed' FROM orders WHERE id = pg_temp.test_id('order-main')),'receipt failure does not reopen successful payout');
SELECT pg_temp.expect_error($cmd$ UPDATE orders SET receipt_state = 'available' WHERE id = pg_temp.test_id('order-main') $cmd$,'23514','available receipt requires receipt reference');
SELECT pg_temp.expect_error($cmd$ UPDATE orders SET payout_state = 'ready' WHERE id = pg_temp.test_id('order-main') $cmd$,'23514','terminal order payout cannot be reopened');

INSERT INTO audit_events (actor_id,action,entity_type,entity_id,request_id,after_state)
VALUES (pg_temp.test_id('maker'),'test','order','test-order','test-request','{}');
SELECT pg_temp.expect_error($cmd$ UPDATE audit_events SET action = 'changed' $cmd$,'23514','audit update forbidden');
SELECT pg_temp.expect_error($cmd$ DELETE FROM audit_events $cmd$,'23514','audit delete forbidden');
SELECT pg_temp.expect_error($cmd$ TRUNCATE audit_events $cmd$,'23514','audit truncate forbidden');
SET CONSTRAINTS ALL IMMEDIATE;
SELECT count(*) AS passed_invariant_checks FROM invariant_results WHERE passed;
ROLLBACK;
