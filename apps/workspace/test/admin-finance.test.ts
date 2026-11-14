import test from "node:test";
import assert from "node:assert/strict";
import { moneyFixture, refundInput, PASSWORD } from "./helpers/money";
import {
  financeSnapshot,
  financePage,
  financeCsv,
  customerPage,
} from "../src/admin-finance";
import { workspaceApp, COOKIE } from "../src/app";
import { OfframpService } from "../../../packages/core/src/service";

test("admin financial snapshot reconciles available, held and settled funds without writes or duplicate journals", async () => {
  const f = await moneyFixture();
  try {
    const movement = await f.money.create(f.user, "refund", refundInput);
    const actor = {
      id: f.user.id,
      role: "customer" as const,
      customerId: f.user.customer_id!,
    };
    const q = await f.core.createQuote(actor, {
      customerId: actor.customerId,
      beneficiaryId: "money-recipient",
      sourceCurrency: "USDC",
      payoutCurrency: "CNY",
      sourceAmount: "10",
    });
    const order = await f.core.createOrder(actor, {
      quoteId: q.id,
      clientOrderId: "admin-finance-order",
      fundingSource: "wallet",
    });
    let s = await financeSnapshot(f.auth, f.admin),
      person = s.people.find((p) => p.id === actor.customerId)!;
    assert.equal(
      person.balances.find((b: any) => b.currency === "USDC")!.withdrawalHeld,
      "5.000000",
    );
    assert.equal(
      person.balances.find((b: any) => b.currency === "USDC")!.orderHeld,
      q.totalDeposit,
    );
    assert.equal(
      person.balances.find((b: any) => b.currency === "USDC")!.total,
      "100.000000",
    );
    const version = await f.pool.query(
      "SELECT version FROM runtime.state WHERE id=1",
    );
    await f.core.confirmManualPayout(
      { id: f.admin.id, role: "merchant_admin" },
      String(order.id),
      {
        outcome: "sent",
        idempotencyKey: "reporting-paid",
        actualAmount: q.payoutAmount,
        paidAt: new Date().toISOString(),
        providerReference: "admin-finance-bank-reference",
        evidence: "Isolated reporting check",
      },
    );
    await f.money.decide(f.user, movement.id, {
      action: "cancel",
      note: "Release reporting test hold",
    });
    s = await financeSnapshot(f.auth, f.admin);
    person = s.people.find((p) => p.id === actor.customerId)!;
    const d = await f.core.dashboard(actor, { readOnly: true });
    assert.equal(
      person.balances.find((b: any) => b.currency === "USDC")!.available,
      d.walletBalances!.find((b: any) => b.currency === "USDC")!.available,
    );
    assert.equal(
      person.balances.find((b: any) => b.currency === "USDC")!.frozen,
      "0.000000",
    );
    const row = s.rows.find((r) => r.id === order.id)!;
    assert.equal(row.status, "completed");
    assert.equal(
      row.postings.filter((p) => p.key.startsWith("fee-")).length,
      2,
    );
    assert.notEqual(row.bookedFees, "0.000000");
    const ids = s.rows.flatMap((r) => r.postings.map((p) => p.id));
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(
      ids.length,
      (await f.pool.query("SELECT count(*)::int n FROM runtime.journals"))
        .rows[0].n,
    );
    const before = JSON.stringify(
      (await f.pool.query("SELECT version FROM runtime.state WHERE id=1")).rows,
    );
    await financeSnapshot(f.auth, f.admin);
    assert.equal(
      JSON.stringify(
        (await f.pool.query("SELECT version FROM runtime.state WHERE id=1"))
          .rows,
      ),
      before,
    );
    assert.notDeepEqual(
      version.rows,
      (await f.pool.query("SELECT version FROM runtime.state WHERE id=1")).rows,
    );
    const json = JSON.stringify(s);
    for (const secret of [
      "password_hash",
      "totp_secret",
      "recovery_hashes",
      "dataBase64",
      "accountToken",
      "encrypted",
    ])
      assert(!json.includes(secret));
  } finally {
    await f.db.close();
  }
});
test("financial filters, pagination, exact micro amounts and complete filtered CSV preserve pending versus credited amounts", async () => {
  const f = await moneyFixture();
  try {
    await f.funding.create(f.user, {
      currency: "USDC",
      network: "usdcbase",
      amount: "10",
      idempotencyKey: "report-pending",
    });
    const partial = await f.funding.create(f.user, {
      currency: "USDC",
      network: "usdcbase",
      amount: "20",
      idempotencyKey: "report-partial",
    });
    Object.assign(f.payments.get("103"), {
      payment_status: "partially_paid",
      outcome_amount: 17,
    });
    await f.funding.refresh({ id: partial.id, provider_id: "103" });
    await f.funding.resolve(f.admin, partial.id, {
      decision: "accept_partial",
      note: "Verified isolated net settlement",
    });
    const core = new OfframpService(f.store);
    await core.depositWallet(
      { id: f.user.id, role: "customer", customerId: f.user.customer_id! },
      {
        customerId: f.user.customer_id!,
        currency: "USDC",
        amount: "0.000001",
        idempotencyKey: "report-micro",
      },
    );
    const other = await f.auth.register({
      email: "empty-report@example.com",
      password: PASSWORD,
      name: "=SUM(1,1)",
      kind: "company",
    });
    const s = await financeSnapshot(f.auth, f.admin),
      p = financePage(s, new URLSearchParams("kind=deposit&limit=1"));
    assert.equal(p.total, 3);
    assert.equal(p.records.length, 1);
    assert.equal(p.summary[0].deposits, "117.000000");
    assert.equal(p.summary[0].pending, "10.000000");
    const micro = financePage(s, new URLSearchParams("kind=simulated_deposit"));
    assert.equal(micro.records[0].amount, "0.000001");
    assert.equal(micro.summary[0].simulatedDeposits, "0.000001");
    const csv = financeCsv(
      financePage(s, new URLSearchParams("kind=deposit&format=csv&limit=1")),
    );
    assert.equal(csv.split("\r\n").length, 4);
    assert(csv.includes("100.000000"));
    const empty = customerPage(
      s,
      new URLSearchParams("q=empty-report&kind=company"),
    );
    assert.equal(empty.total, 1);
    assert.equal(empty.records[0].orderCount, 0);
    assert.equal(empty.records[0].balances[0].total, "0.000000");
    assert.equal(
      financePage(s, new URLSearchParams("q=DOES-NOT-EXIST")).total,
      0,
    );
    assert.throws(() =>
      financePage(
        s,
        new URLSearchParams(
          "from=2026-11-15T00:00:00Z&to=2026-11-14T00:00:00Z",
        ),
      ),
    );
    assert.throws(() => financePage(s, new URLSearchParams("limit=101")));
    assert.throws(() => financePage(s, new URLSearchParams("page=1 OR 1=1")));
    const fake = {
      ...p,
      total: 1,
      records: [{ ...p.records[0], customerName: "=SUM(1,1)" }],
    };
    assert(financeCsv(fake).includes("' =SUM".replace(" ", "")));
    assert.throws(
      () => financeCsv({ ...p, total: 10001 }),
      (e) => (e as any).code === "EXPORT_TOO_LARGE",
    );
    assert(s.people.some((p) => p.id === other.customerId));
  } finally {
    await f.db.close();
  }
});
test("native admin reporting and customer profiles deny customer/provider/partner access and hide credentials", async () => {
  const f = await moneyFixture();
  try {
    const app = workspaceApp(f.auth, {} as any, "https://workspace.example", {
      fundsMode: "sandbox",
    });
    const admin = await f.auth.login(
        { identifier: "moneyadmin", password: PASSWORD },
        "finance-admin-test",
      ),
      user = await f.auth.login(
        { identifier: f.user.email!, password: PASSWORD },
        "finance-user-test",
      );
    for (const path of [
      "/admin/finance/transactions",
      "/admin/finance/transactions?format=csv",
      "/admin/customers",
      "/admin/customers/" + f.user.customer_id,
    ]) {
      const r = await app(
        new Request("https://workspace.example/workspace/api" + path, {
          headers: { cookie: COOKIE + "=" + user.token },
        }),
        "finance-user-test",
      );
      assert.equal(r.status, 403);
      const ok = await app(
        new Request("https://workspace.example/workspace/api" + path, {
          headers: { cookie: COOKIE + "=" + admin.token },
        }),
        "finance-admin-test",
      );
      assert.equal(ok.status, 200);
      if (path.includes("format=csv"))
        assert.match(
          ok.headers.get("content-disposition")!,
          /financial-transactions\.csv/,
        );
      else assert(!JSON.stringify(await ok.json()).includes("password_hash"));
    }
    for (const role of ["payout_provider", "partner"] as const)
      await assert.rejects(
        () => financeSnapshot(f.auth, { ...f.admin, role }),
        (e) => (e as any).status === 403,
      );
    const missing = await app(
      new Request(
        "https://workspace.example/workspace/api/admin/customers/not-a-customer",
        { headers: { cookie: COOKIE + "=" + admin.token } },
      ),
      "finance-admin-test",
    );
    assert.equal(missing.status, 404);
  } finally {
    await f.db.close();
  }
});
