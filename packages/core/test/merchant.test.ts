import test from "node:test";
import assert from "node:assert/strict";
import { ACTORS } from "../src/fixtures";
import { convert, decimal, units } from "../src/money";
import { harness, order, deposit, customer } from "./helpers";
const admin = ACTORS["admin-demo"];
const paid = (
  h: ReturnType<typeof harness>,
  o: any,
  key = "manual-payment",
) => ({
  idempotencyKey: key,
  outcome: "sent",
  actualAmount: o.quote.payoutAmount,
  paidAt: h.now.toISOString(),
  providerReference: "ref-" + o.id,
  evidence: "Mock admin declaration, no actual payment",
});
test("target fiat reverses with upward micro-unit rounding and exact fiat amount", async () => {
  for (const [target, beneficiary, currency, principal] of [
    ["100000", "beneficiary-cn", "CNY", "13888.888889"],
    ["50000", "beneficiary-us", "USD", "50251.256282"],
    ["0.01", "beneficiary-cn", "CNY", "0.001389"],
  ] as const) {
    const h = harness();
    const q = await h.service.createQuote(customer, {
      customerId: "customer-1",
      beneficiaryId: beneficiary,
      sourceCurrency: "USDT",
      amountMode: "target_payout",
      targetAmount: target,
      payoutCurrency: currency,
    });
    assert.equal(q.sourceAmount, principal);
    assert.equal(q.payoutAmount, Number(target).toFixed(2));
    assert.equal(q.inputCurrency, currency);
    assert.notEqual(
      convert(
        decimal(units(principal, 6) - 1n, 6),
        "USDT",
        currency,
        q.customerRate!,
      ),
      q.payoutAmount,
    );
  }
});
test("reverse quotes reject mixed inputs, mismatched currency and sub-cent targets", async () => {
  const h = harness();
  const input = {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDT",
    amountMode: "target_payout",
    targetAmount: "10",
  };
  for (const patch of [
    { sourceAmount: "1" },
    { payoutCurrency: "USD" },
    { targetAmount: "0.001" },
  ])
    await assert.rejects(
      h.service.createQuote(customer, { ...input, ...patch }),
    );
});
test("funding deadline separate from quote acceptance; mock instructions never payable", async () => {
  const h = harness();
  const o = await order(h);
  assert.equal(o.fundingInstruction.address, null);
  assert.equal(o.fundingInstruction.payable, false);
  assert.equal(o.fundingInstruction.network, "MOCK");
  h.advance(301000);
  await deposit(h, o);
  assert.equal((await h.store.read()).orders[0].depositStatus, "confirmed");
});
test("one admin can attest paid without approval switching; repeats are idempotent and conflicts blocked", async () => {
  const h = harness();
  const o = await order(h);
  const p = paid(h, o);
  await assert.rejects(
    h.service.confirmManualPayout(admin, o.id, p),
    /Confirmed stablecoin/,
  );
  await deposit(h, o);
  await assert.rejects(h.service.confirmManualPayout(customer, o.id, p));
  await assert.rejects(
    h.service.confirmManualPayout(admin, o.id, { ...p, actualAmount: "1" }),
    /exactly/,
  );
  await h.service.confirmManualPayout(admin, o.id, p);
  await h.service.confirmManualPayout(admin, o.id, p);
  const s = await h.store.read();
  assert.equal(s.orders[0].payoutStatus, "sent");
  assert.equal(s.orders[0].receiptStatus, "none");
  assert.equal(
    s.orders[0].paymentConfirmation?.verification,
    "admin_attestation",
  );
  assert.equal(s.attempts.length, 1);
  assert.equal(
    s.journals.filter((j) => j.businessKey === "payout:" + o.id).length,
    1,
  );
  await assert.rejects(
    h.service.confirmManualPayout(admin, o.id, {
      ...p,
      evidence: "Changed content",
    }),
    /reused/,
  );
  await assert.rejects(
    h.service.confirmManualPayout(admin, o.id, {
      ...p,
      idempotencyKey: "again",
    }),
    /repeated/,
  );
  await h.service.reconcile(admin, o.id, {
    providerReference: p.providerReference,
    actualAmount: p.actualAmount,
    evidence: "Mock manual statement cross-check",
  });
  assert.equal((await h.store.read()).orders[0].reconciled, true);
});
test("unknown outcome locks duplicate payment, requires explicit resolution before retry", async () => {
  const h = harness();
  const o = await order(h);
  await deposit(h, o);
  await h.service.confirmManualPayout(admin, o.id, {
    idempotencyKey: "unknown",
    outcome: "unknown",
    evidence: "Portal timed out, outcome not known",
  });
  await assert.rejects(
    h.service.confirmManualPayout(admin, o.id, paid(h, o)),
    /repeated/,
  );
  const a = (await h.store.read()).attempts[0];
  await h.service.resolvePayout(admin, a.id, {
    outcome: "failed",
    evidence: "Checked external portal and statement; no payment occurred",
  });
  await h.service.confirmManualPayout(admin, o.id, paid(h, o));
  assert.equal((await h.store.read()).orders[0].payoutStatus, "sent");
});
test("receipt is optional, order-scoped, signature checked, size limited and not bank verified", async () => {
  const h = harness();
  const o = await order(h);
  await deposit(h, o);
  await h.service.confirmManualPayout(admin, o.id, paid(h, o));
  const file = {
    fileName: "receipt.pdf",
    contentType: "application/pdf",
    dataBase64: Buffer.from("%PDF-1.4\n% synthetic demo file\n%%EOF").toString(
      "base64",
    ),
  };
  await assert.rejects(h.service.uploadReceiptFile(customer, o.id, file));
  await assert.rejects(
    h.service.uploadReceiptFile(admin, o.id, {
      ...file,
      dataBase64: Buffer.from("<html>bad</html>").toString("base64"),
    }),
  );
  await assert.rejects(
    h.service.uploadReceiptFile(admin, o.id, {
      ...file,
      dataBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
    }),
  );
  await h.service.uploadReceiptFile(admin, o.id, file);
  const download = await h.service.downloadReceiptFile(customer, o.id);
  assert.equal(download.dataBase64, file.dataBase64);
  assert.equal(download.scanStatus, "not_scanned");
  await assert.rejects(
    h.service.downloadReceiptFile(ACTORS["company-demo"], o.id),
  );
  await assert.rejects(
    h.service.downloadReceiptFile(ACTORS["partner-demo"], o.id),
  );
  const dashboard: any = await h.service.dashboard(customer);
  assert.equal(dashboard.orders[0].receiptFile, undefined);
  await h.service.reconcile(admin, o.id, {
    providerReference: "ref-" + o.id,
    actualAmount: o.quote.payoutAmount,
    evidence: "Manual statement review",
  });
  assert.equal((await h.store.read()).orders[0].receiptStatus, "uploaded");
});

test("admin sent resolution requires exact amount and time; legacy record cannot bypass it", async () => {
  const h = harness();
  const o = await order(h);
  await deposit(h, o);
  await h.service.confirmManualPayout(admin, o.id, {
    idempotencyKey: "uncertain",
    outcome: "unknown",
    evidence: "External response unknown",
  });
  const a = (await h.store.read()).attempts[0];
  const result = {
    outcome: "sent",
    providerReference: "confirmed-ref",
    evidence: "External statement inspected",
  };
  await assert.rejects(
    h.service.resolvePayout(admin, a.id, result),
    /Amount and payment time/,
  );
  await assert.rejects(
    h.service.resolvePayout(admin, a.id, {
      ...result,
      actualAmount: "1",
      paidAt: h.now.toISOString(),
    }),
    /exactly/,
  );
  await h.service.resolvePayout(admin, a.id, {
    ...result,
    actualAmount: o.quote.payoutAmount,
    paidAt: h.now.toISOString(),
  });
  assert.equal(
    (await h.store.read()).orders[0].paymentConfirmation?.verification,
    "admin_attestation",
  );
  await assert.rejects(
    h.service.recordPayout(admin, a.id, {
      outcome: "sent",
      providerReference: "bypass",
      evidence: "Attempted bypass",
    }),
    /manual payout endpoint/,
  );
});
test("metadata cannot replace an uploaded receipt while retaining unrelated bytes", async () => {
  const h = harness();
  const o = await order(h);
  await deposit(h, o);
  await h.service.confirmManualPayout(admin, o.id, paid(h, o));
  await h.service.uploadReceiptFile(admin, o.id, {
    fileName: "receipt.pdf",
    contentType: "application/pdf",
    dataBase64: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"),
  });
  await assert.rejects(
    h.service.uploadReceipt(admin, o.id, `receipts/${o.id}/other.pdf`),
    /receipt-file endpoint/,
  );
});
test("same admin refund keeps amount cap and recorded evidence requirements", async () => {
  const h = harness();
  const o = await order(h);
  await deposit(h, o);
  const r = await h.service.requestRefund(admin, o.id, {
    idempotencyKey: "refund",
    kind: "principal",
    amount: o.quote.sourceAmount,
  });
  await h.service.approveRefund(admin, r.id);
  await h.service.recordRefund(admin, r.id, {
    providerReference: "external-refund-ref",
    evidence: "Mock external refund attestation",
  });
  assert.equal((await h.store.read()).refunds[0].status, "recorded");
  await assert.rejects(h.service.confirmManualPayout(admin, o.id, paid(h, o)));
  await assert.rejects(
    h.service.requestRefund(admin, o.id, {
      idempotencyKey: "more-refund",
      kind: "principal",
      amount: "1",
    }),
  );
});
