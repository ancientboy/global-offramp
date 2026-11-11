import test from "node:test";
import assert from "node:assert/strict";
import { ACTORS } from "../src/fixtures";
import { OfframpService } from "../src/service";
import { MemoryStore } from "../src/store";
import {
  harness,
  order,
  deposit,
  customer,
  ready,
  maker,
  checker,
} from "./helpers";
const admin = ACTORS["admin-demo"];
const input = (o: any, key = "mock-confirm") => ({
  idempotencyKey: key,
  expectedAmount: o.quote.payoutAmount,
  beneficiaryId: o.quote.beneficiaryId,
  payoutProviderId: o.payoutProviderSnapshot.id,
});
const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: any) => e.code === code);

test("official MOCK confirmation records objective internal attribution without evidence, receipt or external execution", async () => {
  const h = harness(),
    o = await order(h);
  await deposit(h, o);
  const result: any = await h.service.confirmMockPayout(admin, o.id, {
    ...input(o),
    note: "Reviewed demo recipient",
  });
  const p = result.paymentConfirmation;
  assert.equal(p.verification, "mock_internal_record");
  assert.equal(p.referenceKind, "mock_internal");
  assert.match(p.internalRecordId, /^MOCK-INTERNAL-/);
  assert.equal(p.providerReference, p.internalRecordId);
  assert.equal(p.confirmedBy, admin.id);
  assert.equal(p.confirmedAt, h.now.toISOString());
  assert.match(p.statement, /no external payment was executed or verified/);
  assert.equal(p.note, "Reviewed demo recipient");
  assert.equal(result.receiptStatus, "none");
  assert.equal(result.reconciled, false);
  const s = await h.store.read();
  assert.equal(s.attempts[0].referenceKind, "mock_internal");
  assert.match(s.orders[0].conversion!.evidence, /Synthetic MOCK/);
  assert.equal(
    s.audits.filter((a) => a.action === "payout.admin_attested").length,
    0,
  );
});

test("concurrent same/different-key confirmations consume wallet once and survive restart", async () => {
  const h = harness();
  await h.service.depositWallet(customer, {
    customerId: "customer-1",
    currency: "USDT",
    amount: "2000",
    idempotencyKey: "credit",
  });
  const q = await h.service.createQuote(customer, {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDT",
    sourceAmount: "1000",
  });
  const o: any = await h.service.createOrder(customer, {
    quoteId: q.id,
    clientOrderId: "wallet",
    fundingSource: "wallet",
  });
  const results: any[] = await Promise.all(
    ["a", "a", "b"].map((key) =>
      h.service.confirmMockPayout(admin, o.id, input(o, key)),
    ),
  );
  assert.equal(
    new Set(results.map((r) => r.paymentConfirmation.internalRecordId)).size,
    1,
  );
  const s = await h.store.read();
  assert.equal(s.orders[0].walletFundingStatus, "consumed");
  assert.equal(s.attempts.length, 1);
  assert.equal(
    s.journals.filter((j) => j.businessKey === "payout:" + o.id).length,
    1,
  );
  const restarted = new OfframpService(
    new MemoryStore(JSON.parse(JSON.stringify(s))),
    () => h.now,
  );
  const again: any = await restarted.confirmMockPayout(
    admin,
    o.id,
    input(o, "b"),
  );
  assert.equal(
    again.paymentConfirmation.internalRecordId,
    results[0].paymentConfirmation.internalRecordId,
  );
  await rejects(
    restarted.confirmMockPayout(admin, o.id, {
      ...input(o, "a"),
      note: "Changed",
    }),
    "IDEMPOTENCY_CONFLICT",
  );
  await rejects(
    restarted.confirmMockPayout(admin, o.id, {
      ...input(o, "b"),
      expectedAmount: "1",
    }),
    "IDEMPOTENCY_CONFLICT",
  );
  await rejects(
    restarted.confirmMockPayout(admin, o.id, {
      ...input(o, "c"),
      beneficiaryId: "other",
    }),
    "BENEFICIARY_MISMATCH",
  );
});

test("strict checks block unfunded, mismatched, suspended, refunded and discrepant orders", async () => {
  const h = harness(),
    o = await order(h);
  await rejects(
    h.service.confirmMockPayout(admin, o.id, input(o)),
    "FUNDS_NOT_READY",
  );
  await deposit(h, o);
  await rejects(
    h.service.confirmMockPayout(customer, o.id, input(o)),
    "FORBIDDEN",
  );
  await rejects(
    h.service.confirmMockPayout(admin, o.id, {
      ...input(o),
      expectedAmount: "1",
    }),
    "PAYOUT_AMOUNT_MISMATCH",
  );
  await rejects(
    h.service.confirmMockPayout(admin, o.id, {
      ...input(o),
      payoutProviderId: "other",
    }),
    "PAYOUT_PROVIDER_MISMATCH",
  );
  await assert.rejects(
    h.service.confirmMockPayout(admin, o.id, {
      ...input(o),
      providerReference: "invented-bank-reference",
    }),
  );
  const state = await h.store.read();
  for (const change of [
    (s: any) => {
      s.customers[0].status = "suspended";
    },
    (s: any) => {
      s.beneficiaries.find((b: any) => b.id === o.quote.beneficiaryId).status =
        "suspended";
    },
    (s: any) => {
      s.refunds.push({ orderId: o.id, kind: "principal" });
    },
    (s: any) => {
      s.discrepancies.push({ orderId: o.id, status: "open" });
    },
    (s: any) => {
      delete s.orders[0].payoutProviderSnapshot;
    },
    (s: any) => {
      s.orders[0].payoutProviderSnapshot.scope = "third_party";
    },
  ]) {
    const copy = structuredClone(state);
    change(copy);
    const store = new MemoryStore(copy),
      service = new OfframpService(store, () => h.now);
    await assert.rejects(service.confirmMockPayout(admin, o.id, input(o)));
    assert.equal((await store.read()).attempts.length, 0);
  }
});

test("untouched legacy approved official attempt is consumed, unknown and resolved failures stay manual", async () => {
  for (const approve of [false, true]) {
    const h = harness(),
      o = await ready(h);
    const attempt = await h.service.preparePayout(
      maker,
      o.id,
      "legacy-prepare",
    );
    if (approve) await h.service.approvePayout(checker, attempt.id);
    await h.service.confirmMockPayout(admin, o.id, input(o));
    const s = await h.store.read();
    assert.equal(s.attempts.length, 1);
    assert.equal(s.attempts[0].id, attempt.id);
    assert.equal(s.attempts[0].state, "sent");
    assert.equal(s.orders[0].paymentConfirmation!.confirmedBy, admin.id);
  }
  const h = harness(),
    o = await order(h);
  await deposit(h, o);
  await h.service.confirmManualPayout(admin, o.id, {
    idempotencyKey: "unknown",
    outcome: "unknown",
    evidence: "Unknown result, must investigate",
  });
  await rejects(
    h.service.confirmMockPayout(admin, o.id, input(o)),
    "PAYOUT_LOCKED",
  );
  const attempt = (await h.store.read()).attempts[0];
  await assert.rejects(
    h.service.resolvePayout(admin, attempt.id, { outcome: "failed" }),
  );
  await h.service.resolvePayout(admin, attempt.id, {
    outcome: "failed",
    evidence: "Manual investigation found no payment",
  });
  await rejects(
    h.service.confirmMockPayout(admin, o.id, input(o)),
    "PAYOUT_LOCKED",
  );
});

test("reconciliation requires human evidence and explicit internal identifier classification", async () => {
  const h = harness(),
    o = await order(h);
  await deposit(h, o);
  const result: any = await h.service.confirmMockPayout(admin, o.id, input(o));
  const reconcile = {
    providerReference: result.paymentConfirmation.internalRecordId,
    actualAmount: o.quote.payoutAmount,
    evidence: "Human cross-check of synthetic internal ledger",
  };
  await rejects(
    h.service.reconcile(admin, o.id, reconcile),
    "REFERENCE_KIND_MISMATCH",
  );
  await assert.rejects(
    h.service.reconcile(admin, o.id, {
      ...reconcile,
      referenceKind: "mock_internal",
      evidence: "",
    }),
  );
  assert.equal(
    (
      await h.service.reconcile(admin, o.id, {
        ...reconcile,
        referenceKind: "mock_internal",
      })
    ).matched,
    true,
  );
  assert.equal((await h.store.read()).orders[0].receiptStatus, "none");
});
