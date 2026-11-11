import test from "node:test";
import assert from "node:assert/strict";
import { harness, sent, order, customer } from "./helpers";
import { ACTORS } from "../src/fixtures";
import { validateReceiptFile } from "../src/receipts";
const admin = ACTORS["admin-demo"];
const file = {
  fileName: "receipt.pdf",
  contentType: "application/pdf",
  dataBase64: Buffer.from("%PDF-1.4 synthetic receipt").toString("base64"),
};
async function register(
  h: ReturnType<typeof harness>,
  suffix = "",
  kind: "single" | "batch" = "single",
) {
  const f = validateReceiptFile({
    ...file,
    dataBase64: Buffer.from("%PDF-1.4 synthetic receipt" + suffix).toString(
      "base64",
    ),
  });
  return h.service.receipts.register(admin, {
    fileName: f.fileName,
    contentType: f.contentType,
    sha256: f.sha256,
    size: f.size,
    objectKey: "private/test/" + f.sha256,
    kind,
    storageMode: "ephemeral_private",
  });
}
test("receipt validation, dedup, admin-only reads and multiple attachments preserve payment state", async () => {
  const h = harness();
  const { o } = await sent(h);
  const a = await register(h);
  const duplicate = await register(h);
  assert.equal(a.id, duplicate.id);
  const b = await register(h, "2");
  for (const r of [a, b])
    await h.service.receipts.link(admin, r.id, {
      orderId: o.id,
      reason: "Manual document review",
      confirmed: true,
    });
  await h.service.receipts.link(admin, a.id, {
    orderId: o.id,
    reason: "Retry manual review",
    confirmed: true,
  });
  const state = await h.store.read();
  assert.equal(state.privateReceipts?.length, 2);
  assert.equal(state.privateReceipts?.[0].links.length, 1);
  assert.deepEqual(state.orders[0].receiptAttachmentIds, [a.id, b.id]);
  assert.equal(state.orders[0].payoutStatus, "sent");
  assert.equal(state.orders[0].reconciled, false);
  await assert.rejects(h.service.receipts.list(customer), /private/);
  await assert.rejects(h.service.receipts.get(customer, a.id), /private/);
  assert.throws(() => validateReceiptFile({ ...file, fileName: "wrong.png" }));
  assert.throws(() =>
    validateReceiptFile({
      ...file,
      dataBase64: Buffer.from("not a pdf").toString("base64"),
    }),
  );
});
test("recognition exact matching, CNH separation, ambiguity and duplicate reference never attach", async () => {
  const h = harness();
  const { o } = await sent(h);
  const r = await register(h);
  const s = await h.store.read();
  const b = s.beneficiaries.find((b) => b.id === o.quote.beneficiaryId)!;
  const fields = {
    amount: o.quote.payoutAmount,
    currency: "CNY",
    recipientName: b.name,
  };
  assert.equal(
    (await h.service.receipts.recognize(admin, r.id, { fields })).matchStatus,
    "candidate",
  );
  assert.equal(
    (
      await h.service.receipts.recognize(admin, r.id, {
        fields: { ...fields, currency: "CNH" },
      })
    ).matchStatus,
    "no_match",
  );
  assert.equal(
    (
      await h.service.receipts.recognize(admin, r.id, {
        fields: {
          ...fields,
          currency: "CNH",
          payoutAmount: o.quote.payoutAmount,
          payoutCurrency: "CNY",
        },
      })
    ).matchStatus,
    "candidate",
  );
  await sent(h);
  assert.equal(
    (await h.service.receipts.recognize(admin, r.id, { fields })).matchStatus,
    "ambiguous",
  );
  const r2 = await register(h, "other");
  await h.service.receipts.recognize(admin, r2.id, {
    fields: { reference: "same" },
  });
  assert.equal(
    (
      await h.service.receipts.recognize(admin, r.id, {
        fields: { ...fields, reference: "same" },
      })
    ).matchStatus,
    "duplicate_reference",
  );
  assert.equal((await h.store.read()).privateReceipts?.[0].links.length, 0);
});
test("explicit publication scoped to own single order and publication prevents later extra associations", async () => {
  const h = harness();
  const { o } = await sent(h);
  const r = await register(h);
  await h.service.receipts.link(admin, r.id, {
    orderId: o.id,
    reason: "Checked single customer",
    confirmed: true,
  });
  await assert.rejects(
    h.service.receipts.publishedGet(customer, r.id),
    /not found/,
  );
  await h.service.receipts.publish(admin, r.id, {
    orderId: o.id,
    confirmedSingleCustomer: true,
    confirmedRedacted: true,
    purpose: "Customer redacted copy",
  });
  assert.equal(
    (await h.service.receipts.publishedGet(customer, r.id)).id,
    r.id,
  );
  const list = await h.service.receipts.publishedList(customer, o.id);
  assert.deepEqual(Object.keys(list[0]).sort(), [
    "contentType",
    "fileName",
    "id",
    "size",
  ]);
  await assert.rejects(
    h.service.receipts.publishedGet(
      { ...customer, customerId: "customer-other" },
      r.id,
    ),
    /scope/,
  );
  await assert.rejects(
    h.service.receipts.publishedGet(ACTORS["partner-demo"], r.id),
  );
  const { o: other } = await sent(h);
  await assert.rejects(
    h.service.receipts.link(admin, r.id, {
      orderId: other.id,
      reason: "Another order",
      confirmed: true,
    }),
    /additional/,
  );
  const batch = await register(h, "batch", "batch");
  await h.service.receipts.link(admin, batch.id, {
    orderId: o.id,
    reason: "Batch reviewed",
    confirmed: true,
  });
  await assert.rejects(
    h.service.receipts.publish(admin, batch.id, {
      orderId: o.id,
      confirmedSingleCustomer: true,
      confirmedRedacted: true,
      purpose: "Wrong copy",
    }),
    /single-order/,
  );
});
test("pending payments cannot be linked and recognition never completes", async () => {
  const h = harness();
  const o = await order(h);
  const r = await register(h);
  await h.service.receipts.recognize(admin, r.id, {
    fields: { sourceStatus: "SUCCESS" },
  });
  await assert.rejects(
    h.service.receipts.link(admin, r.id, {
      orderId: o.id,
      reason: "Not a payment",
      confirmed: true,
    }),
    /sent, failed or unknown orders/,
  );
  const after = (await h.store.read()).orders[0];
  assert.equal(after.payoutStatus, "draft");
  assert.equal(after.completion, undefined);
  assert.equal((await h.store.read()).commissions.length, 0);
});

test("receipt identity, links and publication are append-only; recognition revisions audit hashes only", async () => {
  const h = harness();
  const { o } = await sent(h);
  const r = await register(h);
  await h.service.receipts.recognize(admin, r.id, {
    fields: { recipientName: "Private Person", amount: "100", currency: "CNY" },
  });
  await h.service.receipts.recognize(admin, r.id, {
    fields: {
      recipientName: "Corrected Person",
      amount: "100",
      currency: "CNY",
    },
  });
  const events = (await h.store.read()).audits.filter(
    (a) => a.action === "receipt.recognition_updated",
  );
  assert.equal(events.length, 2);
  assert.equal(events[1].data.revision, 2);
  assert.equal(events[1].data.previousDigest, events[0].data.digest);
  assert.ok(!JSON.stringify(events).includes("Private Person"));
  assert.ok(!JSON.stringify(events).includes("Corrected Person"));
  await assert.rejects(
    h.store.transaction((s) => {
      s.privateReceipts![0].sha256 = "changed";
    }),
    /identity/,
  );
  await assert.rejects(
    h.store.transaction((s) => {
      s.privateReceipts = [];
    }),
    /deleted/,
  );
  await h.service.receipts.link(admin, r.id, {
    orderId: o.id,
    reason: "Manual inspection",
    confirmed: true,
  });
  await assert.rejects(
    h.store.transaction((s) => {
      s.privateReceipts![0].links = [];
    }),
    /associations/,
  );
  await assert.rejects(
    h.store.transaction((s) => {
      s.orders.find((x) => x.id === o.id)!.receiptAttachmentIds = [];
    }),
    /associations/,
  );
  await h.service.receipts.publish(admin, r.id, {
    orderId: o.id,
    confirmedSingleCustomer: true,
    confirmedRedacted: true,
    purpose: "Safe customer copy",
  });
  await assert.rejects(
    h.store.transaction((s) => {
      delete s.privateReceipts![0].published;
    }),
    /grants/,
  );
});

test("table recognition preserves independent row matches, permanently upgrades batch and records row provenance", async () => {
  const h = harness();
  const { o } = await sent(h);
  const r = await register(h);
  const b = (await h.store.read()).beneficiaries.find(
    (b) => b.id === o.quote.beneficiaryId,
  )!;
  const rows = [
    {
      amount: o.quote.payoutAmount,
      currency: "CNY",
      recipientName: b.name,
      accountTail: b.accountMasked.slice(-4),
    },
    {
      amount: o.quote.payoutAmount,
      currency: "CNY",
      recipientName: "Another Customer",
      accountTail: "9876",
    },
  ];
  const result = await h.service.receipts.recognize(admin, r.id, {
    fields: {},
    rows,
    selectedRowIndex: 0,
  });
  assert.equal(result.receipt.kind, "batch");
  assert.equal(result.matchStatus, "candidate");
  assert.equal(result.rowCandidates[0].matchStatus, "candidate");
  assert.equal(result.rowCandidates[1].matchStatus, "no_match");
  await h.service.receipts.link(admin, r.id, {
    orderId: o.id,
    reason: "Checked selected table row",
    confirmed: true,
    selectedRowIndex: 0,
    expectedRecognitionDigest: result.receipt.recognitionDigest,
  });
  const stored = await h.service.receipts.get(admin, r.id);
  assert.equal(stored.links[0].selectedRowIndex, 0);
  assert.match(stored.links[0].recognitionDigest!, /^[a-f0-9]{64}$/);
  await assert.rejects(
    h.service.receipts.publish(admin, r.id, {
      orderId: o.id,
      confirmedSingleCustomer: true,
      confirmedRedacted: true,
      purpose: "Must stay private",
    }),
    /single-order/,
  );
  await h.service.receipts.recognize(admin, r.id, { fields: {} });
  assert.equal((await h.service.receipts.get(admin, r.id)).kind, "batch");
  await assert.rejects(
    h.store.transaction((s) => {
      s.privateReceipts![0].kind = "single";
    }),
    /less private/,
  );
  await assert.rejects(
    h.service.receipts.recognize(admin, r.id, {
      fields: {},
      rows,
      selectedRowIndex: 99,
    }),
    /does not exist/,
  );
});

test("published copy discovered as a table is irreversibly quarantined with publication history intact", async () => {
  const h = harness();
  const { o } = await sent(h);
  const r = await register(h);
  await h.service.receipts.link(admin, r.id, {
    orderId: o.id,
    reason: "Single redacted copy",
    confirmed: true,
  });
  await h.service.receipts.publish(admin, r.id, {
    orderId: o.id,
    confirmedSingleCustomer: true,
    confirmedRedacted: true,
    purpose: "Customer copy",
  });
  await h.service.receipts.recognize(admin, r.id, {
    fields: {},
    rows: [{ recipientName: "A" }, { recipientName: "B" }],
  });
  const stored = await h.service.receipts.get(admin, r.id);
  assert.equal(stored.kind, "batch");
  assert.ok(stored.published);
  assert.ok(stored.quarantine);
  await assert.rejects(
    h.service.receipts.publishedGet(customer, r.id),
    /revoked/,
  );
  assert.deepEqual(await h.service.receipts.publishedList(customer, o.id), []);
  await h.service.receipts.recognize(admin, r.id, { fields: {} });
  await assert.rejects(h.service.receipts.publishedGet(customer, r.id));
  await assert.rejects(
    h.store.transaction((s) => {
      delete s.privateReceipts![0].quarantine;
    }),
    /quarantine/,
  );
  assert.equal(
    (await h.store.read()).audits.filter(
      (a) => a.action === "receipt.publication_quarantined",
    ).length,
    1,
  );
});

test("row links require the exact recognition digest reviewed by the operator", async () => {
  const h = harness();
  const { o } = await sent(h);
  const r = await register(h);
  const first = await h.service.receipts.recognize(admin, r.id, {
    fields: {},
    rows: [{ recipientName: "A" }, { recipientName: "B" }],
  });
  const link = {
    orderId: o.id,
    reason: "Reviewed selected row",
    confirmed: true,
    selectedRowIndex: 0,
  };
  await assert.rejects(
    h.service.receipts.link(admin, r.id, link),
    /Recognition changed/,
  );
  const latest = await h.service.receipts.recognize(admin, r.id, {
    fields: {},
    rows: [{ recipientName: "B" }, { recipientName: "A" }],
  });
  await assert.rejects(
    h.service.receipts.link(admin, r.id, {
      ...link,
      expectedRecognitionDigest: first.receipt.recognitionDigest,
    }),
    /Recognition changed/,
  );
  assert.equal((await h.service.receipts.get(admin, r.id)).links.length, 0);
  await h.service.receipts.link(admin, r.id, {
    ...link,
    expectedRecognitionDigest: latest.receipt.recognitionDigest,
  });
  assert.equal(
    (await h.service.receipts.get(admin, r.id)).links[0].recognitionDigest,
    latest.receipt.recognitionDigest,
  );
});

test("same reviewed table row cannot be linked to a second order", async () => {
  const h = harness();
  const { o } = await sent(h);
  const { o: second } = await sent(h);
  const r = await register(h);
  const result = await h.service.receipts.recognize(admin, r.id, {
    fields: {},
    rows: [{ recipientName: "A" }, { recipientName: "B" }],
  });
  const input = {
    orderId: o.id,
    reason: "Reviewed this exact row",
    confirmed: true,
    selectedRowIndex: 0,
    expectedRecognitionDigest: result.receipt.recognitionDigest,
  };
  await h.service.receipts.link(admin, r.id, input);
  await h.service.receipts.link(admin, r.id, input);
  await assert.rejects(
    h.service.receipts.link(admin, r.id, { ...input, orderId: second.id }),
    /already linked/,
  );
  assert.equal((await h.service.receipts.get(admin, r.id)).links.length, 1);
});

import { MemoryStore } from "../src/store";
import { ReceiptService, receiptScopeDigest } from "../src/receipts";
async function batchFixture() {
  const h = harness();
  await sent(h);
  await sent(h);
  const state = await h.store.read();
  // Explicit synthetic submitted batch fixture, including the authoritative item memberships.
  const batchId = "batch-merchant-2";
  state.batches.push({
    id: batchId,
    customerId: "customer-2",
    clientBatchId: "test",
    itemIds: ["item-a", "item-b"],
    createdAt: h.now.toISOString(),
  });
  state.orders.forEach((o, i) => {
    o.customerId = "customer-2";
    o.batchId = batchId;
    state.batchItems.push({
      id: i ? "item-b" : "item-a",
      batchId,
      clientItemId: `row-${i}`,
      beneficiaryId: o.quote.beneficiaryId,
      sourceAmount: o.quote.sourceAmount,
      sourceCurrency: "USDT",
      status: "created",
      errors: [],
      orderId: o.id,
    });
  });
  const store = new MemoryStore(state),
    service = new ReceiptService(store, () => h.now);
  const f = validateReceiptFile(file);
  const { bytes, ...metadata } = f;
  const r = await service.register(admin, {
    ...metadata,
    objectKey: "private/synthetic",
    kind: "batch",
    storageMode: "ephemeral_private",
  });
  const rows = [{ recipientName: "A" }, { recipientName: "B" }];
  const recognized = await service.recognize(admin, r.id, { fields: {}, rows });
  const link = async (i: number) =>
    service.link(admin, r.id, {
      orderId: state.orders[i].id,
      reason: "Reviewed original row and merchant",
      confirmed: true,
      selectedRowIndex: i,
      expectedRecognitionDigest: recognized.receipt.recognitionDigest,
    });
  const publish = async (overrides = {}) =>
    service.publishBatch(admin, r.id, {
      customerId: "customer-2",
      batchId,
      expectedScopeDigest: receiptScopeDigest(await service.get(admin, r.id)),
      confirmedSingleCustomer: true,
      confirmedEntireBatch: true,
      confirmedNoOtherCustomerData: true,
      purpose: "Merchant batch original",
      ...overrides,
    });
  return {
    store,
    service,
    r,
    rows,
    link,
    publish,
    batchId,
    orders: state.orders,
  };
}
test("batch grant requires same actual company batch and explicit confirmation, not complete OCR", async () => {
  const h = await batchFixture();
  await h.link(0);
  const stale = receiptScopeDigest(await h.service.get(admin, h.r.id));
  await h.link(1);
  await assert.rejects(
    h.publish({ expectedScopeDigest: stale }),
    /scope changed/,
  );
  await assert.rejects(h.publish({ confirmedEntireBatch: false }));
  await assert.rejects(
    h.publish({ customerId: "customer-1" }),
    /actual submitted batch/,
  );
  await assert.rejects(
    h.publish({ batchId: "other-batch" }),
    /actual submitted batch/,
  );
  await h.publish();
  await h.publish();
  const company = ACTORS["company-demo"];
  assert.equal(
    (await h.service.publishedBatchList(company, h.batchId)).length,
    1,
  );
  assert.equal((await h.service.publishedGet(company, h.r.id)).id, h.r.id);
  const metadata = (await h.service.publishedBatchList(company, h.batchId))[0];
  assert.deepEqual(Object.keys(metadata).sort(), [
    "contentType",
    "fileName",
    "id",
    "size",
  ]);
  await assert.rejects(
    h.service.publishedBatchList(customer, h.batchId),
    /scope/,
  );
  await assert.rejects(h.service.publishedGet(customer, h.r.id), /scope/);
  await assert.rejects(
    h.service.publishedGet(ACTORS["partner-demo"], h.r.id),
    /Only the customer/,
  );
  const restored = new ReceiptService(
    new MemoryStore(await h.store.read()),
    () => new Date(),
  );
  assert.equal((await restored.publishedGet(company, h.r.id)).id, h.r.id);
  await h.service.recognize(admin, h.r.id, { fields: {}, rows: h.rows });
  assert.equal(
    (await h.service.publishedBatchList(company, h.batchId)).length,
    1,
  );
  await h.service.recognize(admin, h.r.id, {
    fields: {},
    rows: [...h.rows, { recipientName: "Unknown" }],
  });
  assert.equal(
    (await h.service.publishedBatchList(company, h.batchId)).length,
    1,
  );
  assert.equal((await h.service.publishedGet(company, h.r.id)).id, h.r.id);
  await assert.rejects(
    h.store.transaction((s) => {
      delete s.privateReceipts![0].batchPublished;
    }),
    /grants/,
  );
});
test("cross-customer, cross-batch and forged batch membership are refused; changes revoke downloads", async () => {
  for (const mode of ["customer", "batch", "membership", "personal"] as const) {
    const h = await batchFixture();
    await h.link(0);
    await h.link(1);
    await h.store.transaction((s) => {
      if (mode === "customer") s.orders[1].customerId = "customer-1";
      if (mode === "batch") s.orders[1].batchId = "another";
      if (mode === "membership") s.batchItems[1].orderId = "unrelated";
      if (mode === "personal")
        s.customers.find((c) => c.id === "customer-2")!.kind = "personal";
    });
    await assert.rejects(h.publish(), /actual submitted batch/);
  }
  const h = await batchFixture();
  await h.link(0);
  await h.link(1);
  await h.publish();
  await h.store.transaction((s) => {
    s.orders[1].customerId = "customer-1";
  });
  await assert.rejects(
    h.service.publishedGet(ACTORS["company-demo"], h.r.id),
    /revoked/,
  );
});
test("editing a different row preserves reviewed rows; same order can append a fresh row confirmation", async () => {
  const h = await batchFixture();
  await h.link(0);
  await h.link(1);
  const updated = await h.service.recognize(admin, h.r.id, {
    fields: {},
    rows: [h.rows[0], { recipientName: "Corrected B" }],
  });
  await h.service.link(admin, h.r.id, {
    orderId: h.orders[1].id,
    reason: "Rechecked corrected second row",
    confirmed: true,
    selectedRowIndex: 1,
    expectedRecognitionDigest: updated.receipt.recognitionDigest,
  });
  assert.equal((await h.service.get(admin, h.r.id)).links.length, 3);
  await h.publish();
  assert.equal(
    (await h.service.publishedBatchList(ACTORS["company-demo"], h.batchId))
      .length,
    1,
  );
});
test("unrecognized PDF can be explicitly shared to a real submitted company batch without row links", async () => {
  const h = await batchFixture();
  await h.service.recognize(admin, h.r.id, { fields: {} });
  await h.publish();
  assert.equal(
    (await h.service.publishedBatchList(ACTORS["company-demo"], h.batchId))
      .length,
    1,
  );
  await assert.rejects(
    h.service.link(admin, h.r.id, {
      orderId: h.orders[0].id,
      reason: "Cannot add after publication",
      confirmed: true,
    }),
    /additional/,
  );
  await h.service.recognize(admin, h.r.id, {
    fields: { confidence: 0 },
    rows: [
      { recipientName: "OCR suggestion" },
      { recipientName: "More suggestions" },
    ],
  });
  assert.equal(
    (await h.service.publishedBatchList(ACTORS["company-demo"], h.batchId))
      .length,
    1,
  );
});
test("failed and unknown receipts can be associated and shared without changing payment outcomes", async () => {
  const h = await batchFixture();
  await h.store.transaction((s) => {
    s.orders[0].payoutStatus = "failed";
    s.orders[1].payoutStatus = "unknown";
  });
  await h.link(0);
  await h.link(1);
  await h.publish();
  const state = await h.store.read();
  assert.deepEqual(
    state.orders.map((o) => o.payoutStatus),
    ["failed", "unknown"],
  );
  assert.equal(
    (await h.service.publishedBatchList(ACTORS["company-demo"], h.batchId))
      .length,
    1,
  );
});

test("an unlinked batch original becomes unreadable if a submitted order is rebound across customers", async () => {
  const h = await batchFixture();
  await h.publish();
  await h.store.transaction((s) => {
    s.orders[1].customerId = "customer-1";
  });
  await assert.rejects(
    h.service.publishedGet(ACTORS["company-demo"], h.r.id),
    /revoked/,
  );
});
