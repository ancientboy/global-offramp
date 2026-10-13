import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PostgresStore, SqlPool } from "../src/store";
import { OfframpService } from "../src/service";
import { ACTORS } from "../src/fixtures";
import { signWebhook } from "../src/security";
const sql = readFileSync("db-runtime.sql", "utf8");
test("runtime PostgreSQL commits business state + balanced ledger + audit + outbox atomically", async () => {
  const db = new PGlite();
  try {
    await db.exec(sql);
    const pool: SqlPool = {
      query: (sql, args) => db.query(sql, args),
      connect: async () => ({ query: (sql, args) => db.query(sql, args) }),
    };
    const store = new PostgresStore(pool);
    await store.initialize();
    const core = new OfframpService(store);
    const q = await core.createQuote(ACTORS["customer-demo"], {
      customerId: "customer-1",
      beneficiaryId: "beneficiary-cn",
      sourceCurrency: "USDT",
      sourceAmount: "1000",
    });
    const o: any = await core.createOrder(ACTORS["customer-demo"], {
      quoteId: q.id,
      clientOrderId: "pg-order",
    });
    const raw = Buffer.from(
      JSON.stringify({
        eventId: "pg-ev",
        transactionId: "pg-tx",
        orderId: o.id,
        currency: "USDT",
        amount: "1007",
        network: "MOCK",
        confirmations: 1,
      }),
    );
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = "mock-secret-at-least-32-characters";
    await core.receiveDeposit(
      raw,
      timestamp,
      signWebhook(raw, timestamp, secret),
      secret,
    );
    assert.equal((await store.read()).orders[0].depositStatus, "confirmed");
    assert.equal(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM runtime.ledger_lines",
        )
      ).rows[0].count,
      2,
    );
    assert.equal(
      (
        await db.query<{ sum: string }>(
          "SELECT sum(debit-credit)::text AS sum FROM runtime.ledger_lines",
        )
      ).rows[0].sum,
      "0.000000000000000000",
    );
    assert.equal(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM runtime.outbox",
        )
      ).rows[0].count,
      2,
    );
    const before = await store.read();
    await assert.rejects(() =>
      store.transaction((s) => {
        s.customers[0].name = "must rollback";
        s.outbox.push({ ...s.outbox[0] });
      }),
    );
    assert.deepEqual(await store.read(), before);
    const j = (
      await db.query<{ id: string }>("SELECT id FROM runtime.journals")
    ).rows[0].id;
    await assert.rejects(
      () =>
        db.query(
          "UPDATE runtime.ledger_lines SET debit=1 WHERE journal_id=$1",
          [j],
        ),
      /append-only/,
    );
    await assert.rejects(
      () =>
        db.query(
          "INSERT INTO runtime.ledger_lines(journal_id,account,currency,debit,credit) VALUES($1,'later','USDT',1,0)",
          [j],
        ),
      /sealed/,
    );
  } finally {
    await db.close();
  }
});
test("runtime PostgreSQL rejects empty, unbalanced, sub-cent and false reversal journals", async () => {
  const db = new PGlite();
  try {
    await db.exec(sql);
    async function rejects(body: string, pattern: RegExp) {
      try {
        await assert.rejects(
          () => db.exec("BEGIN;" + body + "COMMIT;"),
          pattern,
        );
      } finally {
        await db.exec("ROLLBACK;");
      }
    }
    const id = randomUUID();
    await rejects(
      `INSERT INTO runtime.journals(id,business_key,created_at) VALUES('${id}','empty',now());`,
      /not balanced/,
    );
    await rejects(
      `INSERT INTO runtime.journals(id,business_key,created_at) VALUES('${id}','unbalanced',now());INSERT INTO runtime.ledger_lines(journal_id,account,currency,debit,credit) VALUES('${id}','a','USD',1,0),('${id}','b','USD',0,2);`,
      /not balanced/,
    );
    await rejects(
      `INSERT INTO runtime.journals(id,business_key,created_at) VALUES('${id}','precision',now());INSERT INTO runtime.ledger_lines(journal_id,account,currency,debit,credit) VALUES('${id}','a','USD',0.001,0),('${id}','b','USD',0,0.001);`,
      /check constraint/,
    );
    await db.exec(
      `BEGIN;INSERT INTO runtime.journals(id,business_key,created_at) VALUES('${id}','original',now());INSERT INTO runtime.ledger_lines(journal_id,account,currency,debit,credit) VALUES('${id}','a','USD',10,0),('${id}','b','USD',0,10);COMMIT;`,
    );
    const reverse = randomUUID();
    await rejects(
      `INSERT INTO runtime.journals(id,business_key,reversal_of,created_at) VALUES('${reverse}','false-reversal','${id}',now());INSERT INTO runtime.ledger_lines(journal_id,account,currency,debit,credit) VALUES('${reverse}','a','USD',0,1),('${reverse}','b','USD',1,0);`,
      /reversal does not exactly negate/,
    );
    await db.exec(
      `BEGIN;INSERT INTO runtime.journals(id,business_key,reversal_of,created_at) VALUES('${reverse}','true-reversal','${id}',now());INSERT INTO runtime.ledger_lines(journal_id,account,currency,debit,credit) VALUES('${reverse}','a','USD',0,10),('${reverse}','b','USD',10,0);COMMIT;`,
    );
  } finally {
    await db.close();
  }
});
