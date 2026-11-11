import test from "node:test";
import assert from "node:assert/strict";
import { ACTORS } from "../src/fixtures";
import { OfframpService } from "../src/service";
import { MemoryStore } from "../src/store";
import { harness, order, deposit, sent } from "./helpers";
const admin = ACTORS["admin-demo"];
const mockInput = (o: any, key = "complete") => ({
  idempotencyKey: key,
  expectedAmount: o.quote.payoutAmount,
  beneficiaryId: o.quote.beneficiaryId,
  payoutProviderId: o.payoutProviderSnapshot.id,
});
const manualInput = (h: ReturnType<typeof harness>, o: any) => ({
  idempotencyKey: "manual",
  outcome: "sent",
  actualAmount: o.quote.payoutAmount,
  paidAt: h.now.toISOString(),
  providerReference: "offline-reference",
  evidence: "Administrator confirms offline payment",
});

test("normal confirmation completes and accrues once without reconciliation or receipt, including concurrent retries", async () => {
  for (const manual of [false, true]) {
    const h = harness(),
      o = await order(h);
    await deposit(h, o);
    const confirm = () =>
      manual
        ? h.service.confirmManualPayout(admin, o.id, manualInput(h, o))
        : h.service.confirmMockPayout(admin, o.id, mockInput(o));
    const results = await Promise.all([confirm(), confirm(), confirm()]);
    for (const result of results) {
      assert.equal(result.completionStatus, "completed");
      assert.equal(result.reconciled, false);
      assert.equal(result.receiptStatus, "none");
      assert.equal(
        result.completionBasis,
        manual ? "admin_attestation" : "mock_internal_record",
      );
    }
    if (!manual)
      await h.service.confirmMockPayout(
        admin,
        o.id,
        mockInput(o, "second-key"),
      );
    let s = await h.store.read();
    assert.equal(s.commissions.length, 1);
    assert.equal(
      s.audits.filter((a) => a.action === "order.completed").length,
      1,
    );
    assert.equal(
      s.journals.filter((j) => j.businessKey.startsWith("commission:")).length,
      1,
    );
    assert.equal(
      ((await h.service.dashboard(admin)) as any).commissions[0].eligibility,
      "hold",
    );
    await h.service.uploadReceipt(
      admin,
      o.id,
      "receipts/" + o.id + "/optional.pdf",
    );
    await confirm();
    s = await h.store.read();
    assert.equal(s.commissions.length, 1);
    assert.equal(
      s.orders[0].completion?.basis,
      manual ? "admin_attestation" : "mock_internal_record",
    );
    h.advance(40 * 86400000);
    assert.equal(
      ((await h.service.dashboard(admin)) as any).commissions[0].eligibility,
      "available",
    );
    const settlement = await h.service.createSettlement(admin, {
      partnerId: "partner-1",
      month: "2026-01",
      currency: "USDT",
    });
    await h.service.approveSettlement(admin, settlement.id);
  }
});

test("unknown/pending/failed do not complete or accrue; successful administrator resolution does", async () => {
  const h = harness(),
    o = await order(h);
  await deposit(h, o);
  assert.equal((await h.store.read()).commissions.length, 0);
  await h.service.confirmManualPayout(admin, o.id, {
    idempotencyKey: "unknown",
    outcome: "unknown",
    evidence: "Uncertain external result",
  });
  await assert.rejects(h.service.confirmMockPayout(admin, o.id, mockInput(o)));
  assert.equal((await h.store.read()).commissions.length, 0);
  const a = (await h.store.read()).attempts[0];
  await h.service.resolvePayout(admin, a.id, {
    outcome: "sent",
    actualAmount: o.quote.payoutAmount,
    paidAt: h.now.toISOString(),
    providerReference: "resolved-ref",
    evidence: "Administrator checked offline result",
  });
  const s = await h.store.read();
  assert.equal(s.orders[0].completion?.basis, "admin_attestation");
  assert.equal(s.orders[0].reconciled, false);
  assert.equal(s.commissions.length, 1);
  const h2 = harness(),
    o2 = await order(h2);
  await deposit(h2, o2);
  await h2.service.confirmManualPayout(admin, o2.id, {
    idempotencyKey: "unknown",
    outcome: "unknown",
    evidence: "Uncertain external result",
  });
  await h2.service.resolvePayout(
    admin,
    (await h2.store.read()).attempts[0].id,
    { outcome: "failed", evidence: "Manual review confirms failure" },
  );
  assert.equal((await h2.store.read()).commissions.length, 0);
});

test("completed commission remains blocked by holds and genuine mismatches", async () => {
  const h = harness(),
    o = await order(h);
  await deposit(h, o);
  const r: any = await h.service.confirmMockPayout(admin, o.id, mockInput(o));
  h.advance(40 * 86400000);
  const st = await h.service.createSettlement(admin, {
    partnerId: "partner-1",
    month: "2026-01",
    currency: "USDT",
  });
  await h.service.reconcile(admin, o.id, {
    referenceKind: "mock_internal",
    providerReference: r.paymentConfirmation.internalRecordId,
    actualAmount: "1",
    evidence: "Mismatch discovered during review",
  });
  await assert.rejects(
    h.service.approveSettlement(admin, st.id),
    (e: any) => e.code === "SETTLEMENT_BLOCKED",
  );
  assert.equal((await h.store.read()).commissions.length, 1);
});

test("service fee refund reverses newly accrued commission exactly once without reconciliation", async () => {
  const h = harness(),
    o = await order(h);
  await deposit(h, o);
  await h.service.confirmMockPayout(admin, o.id, mockInput(o));
  const original = (await h.store.read()).commissions[0];
  const refund = await h.service.requestRefund(admin, o.id, {
    idempotencyKey: "fee-refund",
    kind: "service_fee",
    amount: o.quote.serviceFee,
  });
  await h.service.approveRefund(admin, refund.id);
  const input = {
    providerReference: "refund-reference",
    evidence: "Offline fee refund recorded",
  };
  await h.service.recordRefund(admin, refund.id, input);
  await h.service.recordRefund(admin, refund.id, input);
  await h.service.confirmMockPayout(admin, o.id, mockInput(o, "after-refund"));
  const s = await h.store.read();
  assert.equal(s.commissions.length, 2);
  assert.equal(s.commissions[1].value, "-" + original.value);
  assert.equal(s.commissions[1].originalCommissionId, original.id);
});

test("legacy sent records remain reviewable, explicit confirmation replay upgrades once", async () => {
  const h = harness(),
    o = await order(h);
  await deposit(h, o);
  await h.service.confirmMockPayout(admin, o.id, mockInput(o));
  const s = await h.store.read();
  delete s.orders[0].completion;
  s.commissions = [];
  s.journals = s.journals.filter(
    (j) => !j.businessKey.startsWith("commission:"),
  );
  const store = new MemoryStore(s),
    service = new OfframpService(store, () => h.now);
  assert.equal(
    ((await service.dashboard(admin)) as any).orders[0].completionStatus,
    "pending_review",
  );
  await service.confirmMockPayout(admin, o.id, mockInput(o));
  await service.confirmMockPayout(admin, o.id, mockInput(o));
  assert.equal((await store.read()).commissions.length, 1);
  assert.equal(
    ((await service.dashboard(admin)) as any).orders[0].completionStatus,
    "completed",
  );
  const legacy = harness(),
    paid = await sent(legacy);
  assert.equal(
    ((await legacy.service.dashboard(admin)) as any).orders[0].completionStatus,
    "pending_review",
  );
  assert.equal((await legacy.store.read()).commissions.length, 0);
  await legacy.service.reconcile(admin, paid.o.id, {
    providerReference: "payref-" + paid.o.id,
    actualAmount: paid.o.quote.payoutAmount,
    evidence: "Legacy financial review evidence",
  });
  assert.equal(
    ((await legacy.service.dashboard(admin)) as any).orders[0].completionStatus,
    "completed",
  );
  assert.equal((await legacy.store.read()).commissions.length, 1);
});

test("explicit historical completion backfills both manual and mock, never sends again and rejects mismatches", async () => {
  for (const manual of [false, true]) {
    const h = harness(),
      o = await order(h);
    await deposit(h, o);
    if (manual)
      await h.service.confirmManualPayout(admin, o.id, manualInput(h, o));
    else await h.service.confirmMockPayout(admin, o.id, mockInput(o));
    const state = await h.store.read();
    delete state.orders[0].completion;
    state.commissions = [];
    state.journals = state.journals.filter(
      (j) => !j.businessKey.startsWith("commission:"),
    );
    const store = new MemoryStore(state),
      service = new OfframpService(store, () => h.now);
    const beforePayouts = state.journals.filter((j) =>
      j.businessKey.startsWith("payout:"),
    ).length;
    await Promise.all([
      service.completeRecordedPayment(admin, o.id),
      service.completeRecordedPayment(admin, o.id),
    ]);
    const after = await store.read();
    assert.equal(after.commissions.length, 1);
    assert.equal(after.attempts.length, state.attempts.length);
    assert.equal(
      after.journals.filter((j) => j.businessKey.startsWith("payout:")).length,
      beforePayouts,
    );
    assert.equal(after.orders[0].reconciled, false);
    for (const patch of [
      (s: typeof state) => {
        s.attempts[0].providerReference = "mismatch";
      },
      (s: typeof state) => {
        s.orders[0].paymentConfirmation!.actualAmount = "1";
      },
      (s: typeof state) => {
        s.orders[0].payoutStatus = "unknown";
      },
      (s: typeof state) => {
        s.discrepancies.push({
          id: "mismatch",
          orderId: o.id,
          kind: "payout_mismatch",
          detail: "Open review",
          status: "open",
        });
      },
    ]) {
      const bad = structuredClone(state);
      patch(bad);
      const badStore = new MemoryStore(bad),
        badService = new OfframpService(badStore, () => h.now);
      await assert.rejects(badService.completeRecordedPayment(admin, o.id));
      assert.equal((await badStore.read()).commissions.length, 0);
    }
    await assert.rejects(
      service.completeRecordedPayment(ACTORS["customer-demo"], o.id),
    );
  }
});
