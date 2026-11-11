import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D1MockStore, type D1Database, type D1Statement } from "./d1-store";
import { OfframpService } from "../packages/core/src/service";
import { ACTORS } from "../packages/core/src/fixtures";
import { createPreviewWorker } from "./worker";
// Execute actual migration SQL against SQLite and independently connected adapters.
// This checks SQL semantics and multi-isolate CAS, not the Cloudflare gateway.
class SqliteD1 implements D1Database {
  constructor(readonly db: DatabaseSync) {}
  prepare(sql: string): D1Statement {
    let values: SQLInputValue[] = [];
    const prepared: D1Statement = {
      bind(...args) {
        values = args as SQLInputValue[];
        return prepared;
      },
      first: async <T>() =>
        (this.db.prepare(sql).get(...values) ?? null) as T | null,
      run: async () => ({
        success: true,
        meta: { changes: Number(this.db.prepare(sql).run(...values).changes) },
      }),
    };
    return prepared;
  }
}
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "offramp-d1-"));
  const a = new DatabaseSync(join(dir, "demo.sqlite"));
  const migrations = new URL("../drizzle/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((x) => x.endsWith(".sql"))
    .sort())
    a.exec(readFileSync(new URL(file, migrations), "utf8"));
  const b = new DatabaseSync(join(dir, "demo.sqlite"));
  t.after(() => {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return [new SqliteD1(a), new SqliteD1(b)];
}
const actor = ACTORS["customer-demo"];
const credit = {
  customerId: "customer-1",
  currency: "USDT",
  amount: "107",
  idempotencyKey: "credit",
};
const svc = (db: D1Database, owner = "visitor-one") =>
  new OfframpService(new D1MockStore(db, owner));
test("SQL migration, separate isolates and restart preserve exactly-once wallet credit", async (t) => {
  const [db1, db2] = fixture(t);
  await Promise.all([
    svc(db1).depositWallet(actor, credit),
    svc(db2).depositWallet(actor, credit),
  ]);
  const reopened = svc(db2);
  await reopened.depositWallet(actor, credit);
  const state = await reopened.store.read();
  assert.equal(state.journals.length, 1);
  assert.equal((await reopened.dashboard(actor)).walletDeposits!.length, 1);
  assert.equal(
    (await reopened.dashboard(actor)).walletBalances![0].available,
    "107.000000",
  );
  assert.equal((await svc(db1, "visitor-two").store.read()).journals.length, 0);
});
test("SQL CAS prevents concurrent overspending and preserves every independent append", async (t) => {
  const [db1, db2] = fixture(t);
  const s1 = svc(db1),
    s2 = svc(db2);
  await s1.depositWallet(actor, credit);
  const input = {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDT",
    sourceAmount: "100",
  };
  const quotes = await Promise.all([
    s1.createQuote(actor, input),
    s2.createQuote(actor, input),
  ]);
  assert.equal((await s1.store.read()).quotes.length, 2);
  const results = await Promise.allSettled(
    quotes.map((q, i) =>
      [s1, s2][i].createOrder(actor, {
        quoteId: q.id,
        clientOrderId: "order-" + i,
        fundingSource: "wallet",
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await s2.store.read()).orders.length, 1);
  assert.equal(
    (await s2.dashboard(actor)).walletBalances![0].available,
    "0.000000",
  );
});
test("append-only, failed transactions and capacity preserve stored history", async (t) => {
  const [db] = fixture(t);
  const service = svc(db);
  await service.depositWallet(actor, credit);
  await assert.rejects(
    service.store.transaction((s) => {
      s.journals.splice(0);
    }),
    (e: any) => e.code === "IMMUTABLE_RECORD",
  );
  await assert.rejects(
    service.store.transaction((s) => {
      s.audits.splice(0);
    }),
    (e: any) => e.code === "IMMUTABLE_RECORD",
  );
  await assert.rejects(
    new D1MockStore(db, "visitor-one", 1).transaction(() => {}),
    (e: any) => e.code === "STORAGE_CAPACITY",
  );
  assert.equal((await svc(db).store.read()).journals.length, 1);
});
test("uncertain committed write is not retried internally; idempotent replay survives", async (t) => {
  const [db] = fixture(t);
  let writes = 0;
  const uncertain: D1Database = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const wrapped: D1Statement = {
        bind(...values) {
          stmt.bind(...values);
          return wrapped;
        },
        first: () => stmt.first(),
        run: async () => {
          const result = await stmt.run();
          if (sql.startsWith("UPDATE")) {
            writes++;
            throw new Error("lost response");
          }
          return result;
        },
      };
      return wrapped;
    },
  };
  await assert.rejects(
    svc(uncertain).depositWallet(actor, credit),
    /lost response/,
  );
  assert.equal(writes, 1);
  await svc(db).depositWallet(actor, credit);
  assert.equal((await svc(db).store.read()).journals.length, 1);
});
test("gateway identity required, actor cannot select namespace, restart and cookie rotation retain history", async (t) => {
  const [DB] = fixture(t);
  const env = { DB, ASSETS: { fetch: async () => new Response("static") } };
  const request = (
    path: string,
    owner?: string,
    cookie?: string,
    body?: unknown,
  ) =>
    new Request("https://demo.example/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-demo-actor": "customer-demo",
        ...(owner ? { "oai-authenticated-user-id": owner } : {}),
        ...(cookie ? { cookie } : {}),
        "content-type": "application/json",
        origin: "https://demo.example",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const w1 = createPreviewWorker();
  assert.equal((await w1.fetch(request("dashboard"), env)).status, 401);
  const initial = await w1.fetch(request("dashboard", "one"), env);
  const cookie = initial.headers.get("set-cookie")!.split(";")[0];
  assert.equal(
    (await w1.fetch(request("wallet/deposits", "one", cookie, credit), env))
      .status,
    200,
  );
  const w2 = createPreviewWorker();
  const fresh = await w2.fetch(request("dashboard", "one"), env);
  const data: any = await fresh.json();
  assert.equal(data.walletDeposits.length, 1);
  const rotated = fresh.headers.get("set-cookie")!.split(";")[0];
  const other: any = await (
    await w2.fetch(request("dashboard", "two", rotated), env)
  ).json();
  assert.equal(other.walletDeposits.length, 0);
  const adminReset = request("demo/reset", "one", rotated, {
    confirm: "reset-synthetic-session",
  });
  adminReset.headers.set("x-demo-actor", "admin-demo");
  assert.equal((await w2.fetch(adminReset, env)).status, 403);
  const health: any = await (await w2.fetch(request("health"), env)).json();
  assert.equal(health.persistence, "d1_mock");
  assert.equal(health.volatile, false);
});
test("unknown payout survives reconstruction and cannot release or pay wallet twice", async (t) => {
  const [db1, db2] = fixture(t);
  const first = svc(db1);
  await first.depositWallet(actor, credit);
  const q = await first.createQuote(actor, {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDT",
    sourceAmount: "100",
  });
  const order: any = await first.createOrder(actor, {
    quoteId: q.id,
    clientOrderId: "unknown",
    fundingSource: "wallet",
  });
  await first.confirmManualPayout(ACTORS["admin-demo"], order.id, {
    idempotencyKey: "pay",
    outcome: "unknown",
    evidence: "synthetic uncertain result",
  });
  const reopened = svc(db2);
  await assert.rejects(
    reopened.cancelOrder(actor, order.id, { reason: "unsafe cancel" }),
    (e: any) => e.code === "PAYOUT_LOCKED",
  );
  await assert.rejects(
    reopened.confirmManualPayout(ACTORS["admin-demo"], order.id, {
      idempotencyKey: "retry",
      outcome: "sent",
      evidence: "synthetic retry",
      actualAmount: order.quote.payoutAmount,
      paidAt: new Date().toISOString(),
      providerReference: "mock-ref",
    }),
  );
  assert.equal(
    (await reopened.dashboard(actor)).walletBalances![0].frozen,
    "107.000000",
  );
  assert.equal((await reopened.store.read()).attempts.length, 1);
  await assert.rejects(
    reopened.store.transaction((s) => {
      s.orders[0].quote.customerRate = "0.00000000";
    }),
    (e: any) => e.code === "IMMUTABLE_QUOTE",
  );
});
test("health checks migrated schema and durable receipt cap is explicit", async (t) => {
  const [DB] = fixture(t);
  const env = { DB, ASSETS: { fetch: async () => new Response("static") } };
  const worker = createPreviewWorker();
  const dashboard = await worker.fetch(
    new Request("https://demo.example/api/dashboard", {
      headers: {
        "oai-authenticated-user-id": "one",
        "x-demo-actor": "admin-demo",
      },
    }),
    env,
  );
  const cookie = dashboard.headers.get("set-cookie")!.split(";")[0];
  const response = await worker.fetch(
    new Request("https://demo.example/api/orders/order-example/receipt-file", {
      method: "POST",
      headers: {
        "oai-authenticated-user-id": "one",
        "x-demo-actor": "admin-demo",
        cookie,
        origin: "https://demo.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fileName: "mock.pdf",
        contentType: "application/pdf",
        dataBase64: Buffer.alloc(262145).toString("base64"),
      }),
    }),
    env,
  );
  assert.equal(response.status, 413);
  assert.equal(((await response.json()) as any).error, "RECEIPT_TOO_LARGE");
  DB.db.exec("DROP TABLE offramp_mock_state");
  assert.equal(
    (await worker.fetch(new Request("https://demo.example/api/health"), env))
      .status,
    503,
  );
});

test("official MOCK payout is exactly once across D1 isolates, concurrent keys and reconstruction", async (t) => {
  const [db1, db2] = fixture(t);
  const first = svc(db1),
    second = svc(db2);
  const admin = ACTORS["admin-demo"];
  await first.depositWallet(actor, credit);
  const q = await first.createQuote(actor, {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDT",
    sourceAmount: "100",
  });
  const order: any = await first.createOrder(actor, {
    quoteId: q.id,
    clientOrderId: "mock-official",
    fundingSource: "wallet",
  });
  assert.equal(order.payoutProviderSnapshot.scope, "official");
  const input = (idempotencyKey: string) => ({
    idempotencyKey,
    expectedAmount: order.quote.payoutAmount,
    beneficiaryId: order.quote.beneficiaryId,
    payoutProviderId: order.payoutProviderSnapshot.id,
  });
  const results: any[] = await Promise.all([
    first.confirmMockPayout(admin, order.id, input("pay-a")),
    second.confirmMockPayout(admin, order.id, input("pay-a")),
    svc(db2).confirmMockPayout(admin, order.id, input("pay-b")),
  ]);
  const recordId = results[0].paymentConfirmation.internalRecordId;
  assert.match(recordId, /^MOCK-INTERNAL-/);
  for (const result of results) {
    assert.equal(result.paymentConfirmation.internalRecordId, recordId);
    assert.equal(result.paymentConfirmation.referenceKind, "mock_internal");
    assert.equal(result.paymentConfirmation.confirmedBy, admin.id);
  }
  const before = await first.store.read();
  const reopened = svc(db2);
  for (const key of ["pay-a", "pay-b", "pay-c"]) {
    const replay: any = await reopened.confirmMockPayout(
      admin,
      order.id,
      input(key),
    );
    assert.equal(replay.paymentConfirmation.internalRecordId, recordId);
  }
  await assert.rejects(
    svc(db1).confirmMockPayout(admin, order.id, {
      ...input("pay-b"),
      note: "Changed request",
    }),
    (e: any) => e.code === "IDEMPOTENCY_CONFLICT",
  );
  const after = await svc(db1).store.read();
  assert.equal(after.attempts.length, 1);
  assert.equal(after.attempts[0].internalRecordId, recordId);
  assert.equal(after.orders[0].walletFundingStatus, "consumed");
  assert.equal(after.orders[0].payoutStatus, "sent");
  assert.equal(after.orders[0].reconciled, false);
  assert.equal(after.orders[0].receiptStatus, "none");
  assert.deepEqual(after.journals, before.journals);
  assert.equal(
    after.journals.filter((j) => j.businessKey === "payout:" + order.id).length,
    1,
  );
  for (const prefix of [
    "conversion-source:",
    "conversion-target:",
    "fee-service:",
    "fee-channel:",
  ])
    assert.equal(
      after.journals.filter((j) => j.businessKey === prefix + order.id).length,
      1,
    );
  const balance = (await reopened.dashboard(actor)).walletBalances![0];
  assert.equal(balance.available, "0.000000");
  assert.equal(balance.frozen, "0.000000");
  const reconciliation = {
    providerReference: recordId,
    actualAmount: order.quote.payoutAmount,
    evidence: "Human review of persisted synthetic ledger",
  };
  await assert.rejects(
    reopened.reconcile(admin, order.id, reconciliation),
    (e: any) => e.code === "REFERENCE_KIND_MISMATCH",
  );
  assert.equal(
    (
      await reopened.reconcile(admin, order.id, {
        ...reconciliation,
        referenceKind: "mock_internal",
      })
    ).matched,
    true,
  );
});
