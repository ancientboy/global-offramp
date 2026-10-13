import { test } from "node:test";
import assert from "node:assert/strict";
import { ACTORS } from "../src/fixtures";
import { amount, convert, units, DomainError } from "../src/money";
import { postJournal, reverseJournal } from "../src/ledger";
import {
  authorize,
  assertSafeRuntime,
  maskAudit,
  signWebhook,
} from "../src/security";
import {
  MockManualPayoutProvider,
  UnconfiguredPrivateStorage,
} from "../src/adapters";
import {
  harness,
  order,
  ready,
  sent,
  deposit,
  maker,
  checker,
  customer,
  SECRET,
} from "./helpers";
const code = (expected: string) => (e: unknown) =>
  e instanceof DomainError && e.code === expected;
test("exact amounts beyond Number.MAX_SAFE_INTEGER and explicit down-rounding", () => {
  assert.equal(
    amount("9007199254740993.123456", "USDT"),
    "9007199254740993.123456",
  );
  assert.equal(convert("0.123456", "USDT", "CNY", "7.20000000"), "0.88");
  assert.throws(() => units("1e6", 6));
  assert.throws(() => units("1.0000001", 6));
  assert.throws(() => units(1 as any, 6));
});
test("production and real-money startup fail closed", () => {
  assert.throws(() =>
    assertSafeRuntime({ EXECUTION_MODE: "live", DEMO_AUTH: "true" }),
  );
  assert.throws(() =>
    assertSafeRuntime({
      EXECUTION_MODE: "mock",
      DEMO_AUTH: "true",
      NODE_ENV: "production",
    }),
  );
  assert.throws(() => assertSafeRuntime({ EXECUTION_MODE: "mock" }));
});
test("unknown roles, actions and other customer scopes denied", () => {
  assert.throws(() => authorize(maker, "invented"));
  assert.throws(() => authorize(customer, "payout.approve"));
  assert.throws(() => authorize(customer, "order.read", "customer-2"));
});
test("audit masks sensitive data recursively", () => {
  assert.deepEqual(
    maskAudit({
      accountNumber: "123",
      nested: { token: "secret" },
      status: "sent",
    }),
    {
      accountNumber: "[REDACTED]",
      nested: { token: "[REDACTED]" },
      status: "sent",
    },
  );
});
test("quote snapshot uses customer fee override and customer view hides cost", async () => {
  const h = harness();
  const q = await h.service.createQuote(ACTORS["company-demo"], {
    customerId: "customer-2",
    beneficiaryId: "beneficiary-company",
    sourceCurrency: "USDC",
    sourceAmount: "1000",
  });
  assert.equal(q.serviceFee, "3.000000");
  assert.equal(q.totalDeposit, "1005.000000");
  assert.equal(q.costRate, undefined);
  assert.equal((await h.store.read()).quotes[0].costRate, "1.00000000");
});
test("quote expiry and consumption prevent late/repeated new orders", async () => {
  const h = harness();
  const q = await h.service.createQuote(customer, {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDT",
    sourceAmount: "1",
  });
  h.advance(300001);
  await assert.rejects(
    () =>
      h.service.createOrder(customer, { quoteId: q.id, clientOrderId: "late" }),
    code("QUOTE_EXPIRED"),
  );
});
test("idempotent order creation and concurrency make one order", async () => {
  const h = harness();
  const q = await h.service.createQuote(customer, {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDT",
    sourceAmount: "1000",
  });
  const [a, b] = await Promise.all([
    h.service.createOrder(customer, { quoteId: q.id, clientOrderId: "same" }),
    h.service.createOrder(customer, { quoteId: q.id, clientOrderId: "same" }),
  ]);
  assert.equal(a.id, b.id);
  assert.equal((await h.store.read()).orders.length, 1);
  await assert.rejects(
    () =>
      h.service.createOrder(customer, {
        quoteId: q.id,
        clientOrderId: "different",
      }),
    code("QUOTE_CONSUMED"),
  );
});
test("transaction rollback includes state, audit and outbox", async () => {
  const h = harness();
  const before = await h.store.read();
  await assert.rejects(() =>
    h.store.transaction((s) => {
      s.outbox.push({
        id: "bad",
        topic: "bad",
        aggregateId: "x",
        payload: {},
        createdAt: h.now.toISOString(),
      });
      throw Error("rollback");
    }),
  );
  assert.deepEqual(await h.store.read(), before);
});
test("journal must balance in each currency; reversal immutable", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      h.store.transaction((s) =>
        postJournal(
          s,
          "bad",
          [
            { account: "a", currency: "USD", debit: "1", credit: "0" },
            { account: "b", currency: "CNY", debit: "0", credit: "1" },
          ],
          h.now,
        ),
      ),
    code("UNBALANCED_LEDGER"),
  );
  await h.store.transaction((s) => {
    const j = postJournal(
      s,
      "good",
      [
        { account: "a", currency: "USD", debit: "1", credit: "0" },
        { account: "b", currency: "USD", debit: "0", credit: "1" },
      ],
      h.now,
    );
    reverseJournal(s, j.id, "reverse", h.now);
    assert.throws(() => reverseJournal(s, j.id, "reverse-again", h.now));
  });
  await assert.rejects(
    () =>
      h.store.transaction((s) => {
        s.journals[0].lines[0].debit = "2.00";
      }),
    code("IMMUTABLE_RECORD"),
  );
});
test("signed deposit confirmed once; event and transaction deduplication", async () => {
  const h = harness();
  const o = await order(h);
  await deposit(h, o);
  assert.equal((await deposit(h, o)).duplicate, true);
  assert.equal(
    (await deposit(h, o, { eventId: "another-event" })).duplicate,
    true,
  );
  assert.equal((await h.store.read()).journals.length, 1);
  await assert.rejects(
    () => deposit(h, o, { eventId: "changed", amount: "999" }),
    code("EVENT_CONFLICT"),
  );
});
test("webhook signature and timestamp reject spoof and replay window", async () => {
  const h = harness();
  const raw = Buffer.from("{}");
  const ts = Math.floor(h.now.getTime() / 1000).toString();
  await assert.rejects(
    () => h.service.receiveDeposit(raw, ts, "0".repeat(64), SECRET),
    code("BAD_SIGNATURE"),
  );
  await assert.rejects(
    () =>
      h.service.receiveDeposit(
        raw,
        "1000000000",
        signWebhook(raw, "1000000000", SECRET),
        SECRET,
      ),
    code("WEBHOOK_EXPIRED"),
  );
});
test("underpaid, overpaid and expired deposits stay unallocated", async () => {
  for (const input of ["1000", "1008", "expired"]) {
    const h = harness();
    const o = await order(h);
    if (input === "expired") h.advance(300001);
    await deposit(h, o, input === "expired" ? {} : { amount: input });
    const s = await h.store.read();
    assert.equal(s.orders[0].depositStatus, "exception");
    assert.match(s.journals[0].lines[1].account, /unallocated/);
    assert.equal(s.discrepancies.length, 1);
    await assert.rejects(
      () => h.service.preparePayout(maker, o.id, "bad"),
      code("FUNDS_NOT_READY"),
    );
  }
});
test("beneficiary requires independent approval before quoting", async () => {
  const h = harness();
  const b = await h.service.createBeneficiary(maker, {
    customerId: "customer-1",
    name: "New demo recipient",
    country: "CN",
    currency: "CNY",
    accountToken: "mock-token",
    accountMasked: "**** 0008",
  });
  await assert.rejects(
    () =>
      h.service.createQuote(customer, {
        customerId: "customer-1",
        beneficiaryId: b.id,
        sourceCurrency: "USDT",
        sourceAmount: "100",
      }),
    code("BENEFICIARY_BLOCKED"),
  );
  await h.service.approveBeneficiary(checker, b.id);
  assert.equal((await h.store.read()).beneficiaries.at(-1)?.status, "approved");
});
test("maker checker identity separation even with finance role", async () => {
  const h = harness();
  const o = await ready(h);
  const a = await h.service.preparePayout(maker, o.id, "key");
  await assert.rejects(
    () => h.service.approvePayout({ ...checker, id: maker.id }, a.id),
    code("MAKER_CHECKER"),
  );
  assert.equal((await h.store.read()).attempts[0].state, "awaiting_approval");
});
test("unknown result cannot retry until independent no-payment evidence", async () => {
  const h = harness();
  const o = await ready(h);
  const a = await h.service.preparePayout(maker, o.id, "key");
  await h.service.approvePayout(checker, a.id);
  await h.service.recordPayout(maker, a.id, {
    outcome: "unknown",
    evidence: "Portal timed out; no success response",
  });
  await assert.rejects(
    () => h.service.preparePayout(maker, o.id, "retry"),
    code("PAYOUT_LOCKED"),
  );
  await h.service.resolvePayout(checker, a.id, {
    outcome: "failed",
    evidence: "Provider verified no transfer exists",
  });
  const b = await h.service.preparePayout(maker, o.id, "retry");
  assert.notEqual(a.id, b.id);
});
test("sent payout independent from receipt and commission needs reconciliation", async () => {
  const h = harness();
  const { o } = await sent(h);
  let s = await h.store.read();
  assert.equal(s.orders[0].payoutStatus, "sent");
  assert.equal(s.orders[0].receiptStatus, "none");
  assert.equal(s.commissions.length, 0);
  await h.service.reconcile(checker, o.id, {
    providerReference: "payref-" + o.id,
    actualAmount: "7200",
    evidence: "Mock statement verified",
  });
  s = await h.store.read();
  assert.equal(s.commissions[0].value, "1.000000");
  assert.equal(s.commissions[0].base, "5.000000");
  assert.equal(s.orders[0].receiptStatus, "none");
  await h.service.uploadReceipt(maker, o.id, `receipts/${o.id}/customer.pdf`);
  assert.equal((await h.store.read()).orders[0].receiptStatus, "uploaded");
});
test("wrong reconciliation opens queue and cannot unlock commission", async () => {
  const h = harness();
  const { o } = await sent(h);
  const r = await h.service.reconcile(checker, o.id, {
    providerReference: "payref-" + o.id,
    actualAmount: "7199",
    evidence: "Statement evidence",
  });
  assert.equal(r.matched, false);
  assert.equal((await h.store.read()).commissions.length, 0);
  await assert.rejects(
    () =>
      h.service.reconcile(checker, o.id, {
        providerReference: "payref-" + o.id,
        actualAmount: "7200",
        evidence: "Verified evidence",
      }),
    code("OPEN_DISCREPANCY"),
  );
});
test("partial refunds bounded, idempotent and commission reversed proportionally", async () => {
  const h = harness();
  const { o } = await sent(h);
  await h.service.reconcile(checker, o.id, {
    providerReference: "payref-" + o.id,
    actualAmount: "7200",
    evidence: "Verified evidence",
  });
  const r = await h.service.requestRefund(maker, o.id, {
    idempotencyKey: "refund-key",
    kind: "service_fee",
    amount: "2",
  });
  assert.equal(
    (
      await h.service.requestRefund(maker, o.id, {
        idempotencyKey: "refund-key",
        kind: "service_fee",
        amount: "2",
      })
    ).id,
    r.id,
  );
  await h.service.approveRefund(checker, r.id);
  await h.service.recordRefund(maker, r.id, {
    providerReference: "refund-reference",
    evidence: "Mock refund evidence",
  });
  await h.service.recordRefund(maker, r.id, {
    providerReference: "refund-reference",
    evidence: "Mock refund evidence",
  });
  const s = await h.store.read();
  assert.equal(s.commissions.length, 2);
  assert.equal(s.commissions[1].value, "-0.400000");
  await assert.rejects(
    () =>
      h.service.requestRefund(maker, o.id, {
        idempotencyKey: "excess",
        kind: "service_fee",
        amount: "4",
      }),
    code("REFUND_LIMIT"),
  );
});
test("micro-refunds cumulative rounding reverses full commission exactly", async () => {
  const h = harness();
  const { o } = await sent(h);
  await h.service.reconcile(checker, o.id, {
    providerReference: "payref-" + o.id,
    actualAmount: "7200",
    evidence: "Verified evidence",
  });
  for (const [i, value] of ["0.000001", "4.999999"].entries()) {
    const r = await h.service.requestRefund(maker, o.id, {
      idempotencyKey: "r-" + i,
      kind: "service_fee",
      amount: value,
    });
    await h.service.approveRefund(checker, r.id);
    await h.service.recordRefund(maker, r.id, {
      providerReference: "rp-" + i,
      evidence: "Mock refund evidence",
    });
  }
  const c = (await h.store.read()).commissions;
  const total = c.reduce(
    (s, c) =>
      s +
      (c.value.startsWith("-")
        ? -units(c.value.slice(1), 6)
        : units(c.value, 6)),
    0n,
  );
  assert.equal(total, 0n);
});
test("monthly settlement waits hold and independent approval; no payment execution", async () => {
  const h = harness();
  const { o } = await sent(h);
  await h.service.reconcile(checker, o.id, {
    providerReference: "payref-" + o.id,
    actualAmount: "7200",
    evidence: "Verified evidence",
  });
  await assert.rejects(
    () =>
      h.service.createSettlement(checker, {
        partnerId: "partner-1",
        month: "2026-01",
        currency: "USDT",
      }),
    code("OPEN_MONTH"),
  );
  h.advance(32 * 86400000);
  const st = await h.service.createSettlement(checker, {
    partnerId: "partner-1",
    month: "2026-01",
    currency: "USDT",
  });
  assert.equal(st.amount, "1.000000");
  await assert.rejects(
    () => h.service.approveSettlement(checker, st.id),
    code("MAKER_CHECKER"),
  );
  await h.service.approveSettlement(ACTORS["checker-two-demo"], st.id);
  assert.equal((await h.store.read()).settlements[0].status, "approved");
});
test("CSV formula, duplicate, beneficiary scope rejected per row, valid rows submit once", async () => {
  const h = harness();
  const csv =
    "clientItemId,beneficiaryId,sourceCurrency,sourceAmount\none,beneficiary-cn,USDT,100\none,beneficiary-cn,USDT,200\n=SUM(1),beneficiary-cn,USDT,100\nthree,beneficiary-company,USDT,100";
  const result = await h.service.importBatch(
    customer,
    "customer-1",
    "batch-demo",
    csv,
  );
  assert.deepEqual(
    result.items.map((i) => i.status),
    ["valid", "error", "error", "error"],
  );
  await h.service.submitBatch(customer, result.batch.id);
  await h.service.submitBatch(customer, result.batch.id);
  assert.equal((await h.store.read()).orders.length, 1);
  await assert.rejects(
    () => h.service.importBatch(customer, "customer-1", "batch-demo", csv),
    code("DUPLICATE_BATCH"),
  );
});
test("partner/customer views exclude other customers, source principal and private costs", async () => {
  const h = harness();
  const { o } = await sent(h);
  await h.service.reconcile(checker, o.id, {
    providerReference: "payref-" + o.id,
    actualAmount: "7200",
    evidence: "Verified evidence",
  });
  const partner = JSON.stringify(
    await h.service.dashboard(ACTORS["partner-demo"]),
  );
  assert.ok(!partner.includes("sourceAmount"));
  assert.ok(!partner.includes("account"));
  assert.ok(!partner.includes("costRate"));
  const c = JSON.stringify(await h.service.dashboard(customer));
  assert.ok(!c.includes("costRate"));
  assert.ok(!c.includes("accountToken"));
  assert.ok(!c.includes("mock-vault"));
});
test("real payout and unconfigured private files fail closed", async () => {
  await assert.rejects(
    () => new MockManualPayoutProvider().execute(),
    /REAL_EXECUTION_DISABLED/,
  );
  await assert.rejects(
    () => new UnconfiguredPrivateStorage().presignDownload(),
    /PRIVATE_STORAGE_NOT_CONFIGURED/,
  );
});
test("ledger idempotency keys reject changed economics and fake reversals", async () => {
  const h = harness();
  await h.store.transaction((s) => {
    const lines = [
      { account: "a", currency: "USD" as const, debit: "10", credit: "0" },
      { account: "b", currency: "USD" as const, debit: "0", credit: "10" },
    ];
    const j = postJournal(s, "key", lines, h.now);
    assert.equal(postJournal(s, "key", lines, h.now).id, j.id);
    assert.throws(
      () =>
        postJournal(
          s,
          "key",
          lines.map((l) => ({ ...l, account: "changed-" + l.account })),
          h.now,
        ),
      code("IDEMPOTENCY_CONFLICT"),
    );
    assert.throws(
      () =>
        postJournal(
          s,
          "fake-reversal",
          lines.map((l) => ({
            ...l,
            account: "wrong-" + l.account,
            debit: l.credit,
            credit: l.debit,
          })),
          h.now,
          j.id,
        ),
      code("INVALID_REVERSAL"),
    );
  });
});
test("fee refund before accrual and afterward is not double subtracted", async () => {
  const h = harness();
  const { o } = await sent(h);
  async function refund(key: string, value: string) {
    const r = await h.service.requestRefund(maker, o.id, {
      idempotencyKey: key,
      kind: "service_fee",
      amount: value,
    });
    await h.service.approveRefund(checker, r.id);
    await h.service.recordRefund(maker, r.id, {
      providerReference: "provider-" + key,
      evidence: "Mock refund evidence",
    });
  }
  await refund("before", "2");
  await h.service.reconcile(checker, o.id, {
    providerReference: "payref-" + o.id,
    actualAmount: "7200",
    evidence: "Verified evidence",
  });
  assert.equal((await h.store.read()).commissions[0].value, "0.600000");
  await refund("after", "3");
  const c = (await h.store.read()).commissions;
  assert.equal(c[1].value, "-0.600000");
});
test("full fee refund before reconciliation accrues no commission", async () => {
  const h = harness();
  const { o } = await sent(h);
  const r = await h.service.requestRefund(maker, o.id, {
    idempotencyKey: "full",
    kind: "service_fee",
    amount: "5",
  });
  await h.service.approveRefund(checker, r.id);
  await h.service.recordRefund(maker, r.id, {
    providerReference: "full-ref",
    evidence: "Mock refund evidence",
  });
  await h.service.reconcile(checker, o.id, {
    providerReference: "payref-" + o.id,
    actualAmount: "7200",
    evidence: "Verified evidence",
  });
  assert.equal((await h.store.read()).commissions.length, 0);
});
test("client item cannot be duplicated across different batches for same customer", async () => {
  const h = harness();
  const csv =
    "clientItemId,beneficiaryId,sourceCurrency,sourceAmount\npersistent-item,beneficiary-cn,USDT,100";
  const first = await h.service.importBatch(
    customer,
    "customer-1",
    "first-batch",
    csv,
  );
  await h.service.submitBatch(customer, first.batch.id);
  const second = await h.service.importBatch(
    customer,
    "customer-1",
    "second-batch",
    csv,
  );
  assert.equal(second.items[0].status, "error");
  await h.service.submitBatch(customer, second.batch.id);
  assert.equal((await h.store.read()).orders.length, 1);
});
test("unapproved settlement draft is blocked if fee refund changes its commission", async () => {
  const h = harness();
  const { o } = await sent(h);
  await h.service.reconcile(checker, o.id, {
    providerReference: "payref-" + o.id,
    actualAmount: "7200",
    evidence: "Verified evidence",
  });
  h.advance(32 * 86400000);
  const st = await h.service.createSettlement(checker, {
    partnerId: "partner-1",
    month: "2026-01",
    currency: "USDT",
  });
  const r = await h.service.requestRefund(maker, o.id, {
    idempotencyKey: "after-draft",
    kind: "service_fee",
    amount: "2",
  });
  await h.service.approveRefund(checker, r.id);
  await h.service.recordRefund(maker, r.id, {
    providerReference: "refund-after-draft",
    evidence: "Mock refund evidence",
  });
  await assert.rejects(
    () => h.service.approveSettlement(ACTORS["checker-two-demo"], st.id),
    code("SETTLEMENT_STALE"),
  );
});
test("stale settlement can be cancelled, rebuilt including new refund, then independently approved", async () => {
  const h = harness();
  const { o } = await sent(h);
  await h.service.reconcile(checker, o.id, {
    providerReference: "payref-" + o.id,
    actualAmount: "7200",
    evidence: "Verified evidence",
  });
  h.advance(32 * 86400000);
  const input = { partnerId: "partner-1", month: "2026-01", currency: "USDT" };
  const first = await h.service.createSettlement(checker, input);
  const r = await h.service.requestRefund(maker, o.id, {
    idempotencyKey: "rebuild-refund",
    kind: "service_fee",
    amount: "2",
  });
  await h.service.approveRefund(checker, r.id);
  await h.service.recordRefund(maker, r.id, {
    providerReference: "rebuild-provider-refund",
    evidence: "Mock refund evidence",
  });
  await h.service.cancelSettlement(
    checker,
    first.id,
    "Refund changed draft; rebuilding statement",
  );
  const second = await h.service.createSettlement(checker, input);
  assert.notEqual(second.id, first.id);
  assert.equal(second.amount, "0.600000");
  assert.equal(second.commissionIds.length, 2);
  await h.service.approveSettlement(ACTORS["checker-two-demo"], second.id);
  await assert.rejects(
    () =>
      h.service.cancelSettlement(
        checker,
        second.id,
        "Cannot cancel approved record",
      ),
    code("INVALID_STATE"),
  );
  const s = await h.store.read();
  assert.equal(s.settlements[0].status, "cancelled");
  assert.ok(s.audits.some((a) => a.action === "settlement.cancelled"));
});

test("explicit total-deposit mode preserves 1000 total, 993 principal and 7149.60 CNY", async () => {
  const h = harness();
  const q = await h.service.createQuote(customer, {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDT",
    sourceAmount: "1000",
    amountMode: "total_deposit",
  });
  assert.equal(q.amountMode, "total_deposit");
  assert.equal(q.inputAmount, "1000.000000");
  assert.equal(q.totalDeposit, "1000.000000");
  assert.equal(q.sourceAmount, "993.000000");
  assert.equal(q.payoutAmount, "7149.60");
  const o: any = await h.service.createOrder(customer, {
    quoteId: q.id,
    clientOrderId: "total-mode",
  });
  assert.equal(o.quote.amountMode, "total_deposit");
  await deposit(h, o);
  assert.equal((await h.store.read()).orders[0].depositStatus, "confirmed");
});
test("total-deposit mode honors customer fee override and rejects totals consumed by fees", async () => {
  const h = harness();
  const q = await h.service.createQuote(ACTORS["company-demo"], {
    customerId: "customer-2",
    beneficiaryId: "beneficiary-company",
    sourceCurrency: "USDC",
    sourceAmount: "1000",
    amountMode: "total_deposit",
  });
  assert.equal(q.sourceAmount, "995.000000");
  assert.equal(q.totalDeposit, "1000.000000");
  assert.equal(q.serviceFee, "3.000000");
  for (const value of ["0", "6", "7"])
    await assert.rejects(
      () =>
        h.service.createQuote(customer, {
          customerId: "customer-1",
          beneficiaryId: "beneficiary-cn",
          sourceCurrency: "USDT",
          sourceAmount: value,
          amountMode: "total_deposit",
        }),
      code("INVALID_AMOUNT"),
    );
});
