BEGIN;
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='runtime.ledger_lines'::regclass AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%currency%' LOOP
 EXECUTE format('ALTER TABLE runtime.ledger_lines DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
ALTER TABLE runtime.ledger_lines ADD CONSTRAINT ledger_currency_allowed CHECK(currency IN('USDT','USDC','CNY','USD','EUR','GBP','MXN','BRL'));
ALTER TABLE runtime.ledger_lines ADD CONSTRAINT ledger_currency_precision CHECK(debit=round(debit,CASE WHEN currency IN('USDT','USDC') THEN 6 ELSE 2 END) AND credit=round(credit,CASE WHEN currency IN('USDT','USDC') THEN 6 ELSE 2 END));
COMMIT;
