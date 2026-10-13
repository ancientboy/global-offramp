/** Embedded PostgreSQL regression runner; never connects to an external database. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
try {
  const migration = await readFile(new URL('../migrations/001_core.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  console.log('PASS: PostgreSQL migration applied');
  const sql = await readFile(new URL('./invariants.sql', import.meta.url), 'utf8');
  const results = await db.exec(sql);
  const checkCount = results.find(result => result.rows?.[0]?.passed_invariant_checks !== undefined)?.rows[0].passed_invariant_checks;
  assert.ok(Number(checkCount) >= 50, 'Expected at least 50 invariant checks');
  console.log(`PASS: ${checkCount} SQL invariant checks (transaction rolled back)`);

  // This test requires a real transaction boundary and a disposable database.
  await db.exec(`
    SET search_path = offramp, public;
    INSERT INTO actors (id,subject,kind,display_name) VALUES ('10000000-0000-4000-8000-000000000001','sealing-test','human','Sealing test');
    INSERT INTO ledger_accounts (id,code,currency,kind) VALUES
      ('20000000-0000-4000-8000-000000000001','seal.cash','USD','asset'),
      ('20000000-0000-4000-8000-000000000002','seal.revenue','USD','revenue');
    BEGIN;
    INSERT INTO ledger_journals (id,kind,idempotency_key,created_by)
      VALUES ('30000000-0000-4000-8000-000000000001','fee','seal.original','10000000-0000-4000-8000-000000000001');
    INSERT INTO ledger_entries (journal_id,line_number,account_id,currency,amount) VALUES
      ('30000000-0000-4000-8000-000000000001',1,'20000000-0000-4000-8000-000000000001','USD',10),
      ('30000000-0000-4000-8000-000000000001',2,'20000000-0000-4000-8000-000000000002','USD',-10);
    COMMIT;
  `);
  await assert.rejects(
    db.exec(`INSERT INTO offramp.ledger_entries (journal_id,line_number,account_id,currency,amount)
      VALUES ('30000000-0000-4000-8000-000000000001',3,'20000000-0000-4000-8000-000000000001','USD',1)`),
    error => error.code === '23514' && /sealed/.test(error.message),
  );
  console.log('PASS: committed journal rejects later entries');
  const balances = await db.query(`SELECT signed_balance::text FROM offramp.ledger_balances WHERE code = 'seal.cash'`);
  assert.equal(balances.rows[0].signed_balance, '10.000000000000000000');
  console.log('PASS: ledger balances preserve decimal strings');
  console.log('All database checks passed (embedded PostgreSQL; no concurrent-session tests).');
} catch (error) {
  console.error('Database verification FAILED:', error.message);
  if (error.detail) console.error('Detail:', error.detail);
  if (error.where) console.error('Where:', error.where);
  if (error.position) console.error('Position:', error.position);
  process.exitCode = 1;
} finally {
  await db.close();
}
