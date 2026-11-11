import assert from "node:assert/strict";
import test from "node:test";
import { ACTORS } from "../src/fixtures";
import { customer, harness, deposit } from "./helpers";
const admin = ACTORS["admin-demo"];
const credit = (
  h: ReturnType<typeof harness>,
  value = "1000",
  key = "credit",
) =>
  h.service.depositWallet(customer, {
    customerId: "customer-1",
    currency: "USDT",
    amount: value,
    idempotencyKey: key,
  });
async function quote(h: ReturnType<typeof harness>, value = "100") {
  return h.service.createQuote(customer, {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDT",
    sourceAmount: value,
  });
}
async function walletOrder(h: ReturnType<typeof harness>, key = "order") {
  const q = await quote(h);
  return h.service.createOrder(customer, {
    quoteId: q.id,
    clientOrderId: key,
    fundingSource: "wallet",
  }) as Promise<any>;
}
async function balances(h: ReturnType<typeof harness>) {
  const d = await h.service.dashboard(customer);
  return d.walletBalances!.find((x) => x.currency === "USDT")!;
}
const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: any) => e.code === code);
test("wallet deposit is exact, scoped, and idempotent including concurrent retries", async () => {
  const h = harness();
  await Promise.all([credit(h, "0.000001"), credit(h, "0.000001")]);
  assert.equal((await balances(h)).available, "0.000001");
  await rejects(credit(h, "2"), "IDEMPOTENCY_CONFLICT");
  await rejects(
    h.service.depositWallet(customer, {
      customerId: "customer-2",
      currency: "USDT",
      amount: "10",
      idempotencyKey: "wrong",
    }),
    "FORBIDDEN",
  );
  await rejects(
    h.service.depositWallet(customer, {
      customerId: "customer-1",
      currency: "USDC",
      amount: "0.000001",
      idempotencyKey: "credit",
    }),
    "IDEMPOTENCY_CONFLICT",
  );
  assert.equal((await h.store.read()).journals.length, 1);
});
test("wallet order requires funds including fees and cannot allocate twice concurrently", async () => {
  const h = harness();
  const q1 = await quote(h),
    q2 = await quote(h);
  await rejects(
    h.service.createOrder(customer, {
      quoteId: q1.id,
      clientOrderId: "a",
      fundingSource: "wallet",
    }),
    "INSUFFICIENT_BALANCE",
  );
  await credit(h, "107");
  const results = await Promise.allSettled(
    [q1, q2].map((q, i) =>
      h.service.createOrder(customer, {
        quoteId: q.id,
        clientOrderId: "o" + i,
        fundingSource: "wallet",
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const o = (
    results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>
  ).value;
  assert.equal((await balances(h)).available, "0.000000");
  assert.equal((await balances(h)).frozen, "107.000000");
  await h.service.createOrder(customer, {
    quoteId: o.quote.id,
    clientOrderId: o.clientOrderId,
    fundingSource: "wallet",
  });
  await rejects(deposit(h, o), "WALLET_FUNDED");
  await rejects(
    h.service.requestRefund(admin, o.id, {
      idempotencyKey: "refund",
      kind: "principal",
      amount: "100",
    }),
    "WALLET_REFUND_UNSUPPORTED",
  );
  await rejects(
    h.service.cancelOrder(ACTORS["company-demo"], o.id, {
      reason: "cancel test",
    }),
    "FORBIDDEN",
  );
  await h.service.cancelOrder(customer, o.id, { reason: "cancel test" });
  await h.service.cancelOrder(customer, o.id, { reason: "cancel twice" });
  assert.equal((await balances(h)).available, "107.000000");
  assert.equal((await balances(h)).frozen, "0.000000");
  await rejects(
    h.service.confirmManualPayout(admin, o.id, {
      idempotencyKey: "pay",
      outcome: "unknown",
      evidence: "unknown payment",
    }),
    "WALLET_RELEASED",
  );
});
test("unknown and verified failure keep converted wallet funds reserved; safe retry consumes once", async () => {
  const h = harness();
  await credit(h);
  const o = await walletOrder(h);
  await h.service.confirmManualPayout(admin, o.id, {
    idempotencyKey: "pay",
    outcome: "unknown",
    evidence: "unknown payment",
  });
  await rejects(
    h.service.cancelOrder(customer, o.id, { reason: "unsafe cancel" }),
    "PAYOUT_LOCKED",
  );
  assert.equal((await balances(h)).frozen, "107.000000");
  const a = (await h.store.read()).attempts[0];
  await h.service.resolvePayout(admin, a.id, {
    outcome: "failed",
    evidence: "verified no payout",
  });
  assert.equal((await balances(h)).available, "893.000000");
  assert.equal((await balances(h)).frozen, "107.000000");
  await h.service.confirmManualPayout(admin, o.id, {
    idempotencyKey: "retry",
    outcome: "sent",
    actualAmount: o.quote.payoutAmount,
    paidAt: h.now.toISOString(),
    providerReference: "paid",
    evidence: "offline payment attested",
  });
  assert.equal((await balances(h)).available, "893.000000");
  assert.equal((await balances(h)).frozen, "0.000000");
});
test("wallet batches require preview, reject expiry and insufficient aggregate funds atomically", async () => {
  const h = harness();
  const b = await h.service.importBatch(
    customer,
    "customer-1",
    "batch",
    "clientItemId,beneficiaryId,sourceCurrency,sourceAmount\na,beneficiary-cn,USDT,100\nb,beneficiary-cn,USDT,100",
  );
  await credit(h, "107");
  await rejects(
    h.service.submitBatch(customer, b.batch.id, { fundingSource: "wallet" }),
    "BATCH_QUOTE_REQUIRED",
  );
  let quoteIds = (await h.service.quoteBatch(customer, b.batch.id)).quotes.map(
    (q) => q.id,
  );
  await rejects(
    h.service.submitBatch(customer, b.batch.id, {
      fundingSource: "wallet",
      quoteIds,
    }),
    "INSUFFICIENT_BALANCE",
  );
  assert.equal((await h.store.read()).orders.length, 0);
  assert.equal((await balances(h)).available, "107.000000");
  await credit(h, "107", "second");
  h.advance(301000);
  await rejects(
    h.service.submitBatch(customer, b.batch.id, {
      fundingSource: "wallet",
      quoteIds,
    }),
    "QUOTE_EXPIRED",
  );
  const preview = await h.service.quoteBatch(customer, b.batch.id);
  await rejects(
    h.service.submitBatch(customer, b.batch.id, {
      fundingSource: "wallet",
      quoteIds,
    }),
    "BATCH_QUOTE_CHANGED",
  );
  quoteIds = preview.quotes.map((q) => q.id);
  assert.equal(preview.totals[0].totalDeposit, "214.000000");
  await h.store.transaction((s) => {
    s.beneficiaries[0].status = "suspended";
  });
  await rejects(
    h.service.submitBatch(customer, b.batch.id, {
      fundingSource: "wallet",
      quoteIds,
    }),
    "BENEFICIARY_BLOCKED",
  );
  assert.equal((await h.store.read()).orders.length, 0);
  await h.store.transaction((s) => {
    s.beneficiaries[0].status = "approved";
  });
  await Promise.all([
    h.service.submitBatch(customer, b.batch.id, {
      fundingSource: "wallet",
      quoteIds,
    }),
    h.service.submitBatch(customer, b.batch.id, {
      fundingSource: "wallet",
      quoteIds,
    }),
  ]);
  assert.equal((await h.store.read()).orders.length, 2);
  assert.equal((await balances(h)).available, "0.000000");
});
test("wallet balances and deposit activity are customer scoped; partner sees neither", async () => {
  const h = harness();
  await credit(h);
  const other = await h.service.dashboard(ACTORS["company-demo"]);
  assert.equal(other.walletBalances!.length, 2);
  assert.equal(other.walletBalances![0].customerId, "customer-2");
  assert.equal(other.walletDeposits!.length, 0);
  const partner = await h.service.dashboard(ACTORS["partner-demo"]);
  assert.equal(partner.walletBalances, undefined);
  assert.equal(partner.walletDeposits, undefined);
});

test("wallet cannot spend another asset or customer balance and races batch against single atomically", async () => {
  const h = harness();
  await credit(h, "214");
  const usdc = await h.service.createQuote(customer, {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDC",
    sourceAmount: "100",
  });
  await rejects(
    h.service.createOrder(customer, {
      quoteId: usdc.id,
      clientOrderId: "usdc",
      fundingSource: "wallet",
    }),
    "INSUFFICIENT_BALANCE",
  );
  const foreign = await h.service.createQuote(ACTORS["company-demo"], {
    customerId: "customer-2",
    beneficiaryId: "beneficiary-company",
    sourceCurrency: "USDT",
    sourceAmount: "100",
  });
  await rejects(
    h.service.createOrder(customer, {
      quoteId: foreign.id,
      clientOrderId: "foreign",
      fundingSource: "wallet",
    }),
    "FORBIDDEN",
  );
  await rejects(
    h.service.createOrder(ACTORS["company-demo"], {
      quoteId: foreign.id,
      clientOrderId: "company",
      fundingSource: "wallet",
    }),
    "INSUFFICIENT_BALANCE",
  );
  const b = await h.service.importBatch(
    customer,
    "customer-1",
    "race",
    "clientItemId,beneficiaryId,sourceCurrency,sourceAmount\na,beneficiary-cn,USDT,100\nb,beneficiary-cn,USDT,100",
  );
  const preview = await h.service.quoteBatch(customer, b.batch.id);
  const q = await quote(h);
  const results = await Promise.allSettled([
    h.service.submitBatch(customer, b.batch.id, {
      fundingSource: "wallet",
      quoteIds: preview.quotes.map((q) => q.id),
    }),
    h.service.createOrder(customer, {
      quoteId: q.id,
      clientOrderId: "race-single",
      fundingSource: "wallet",
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await balances(h)).available, "0.000000");
  assert.equal((await balances(h)).frozen, "214.000000");
});
