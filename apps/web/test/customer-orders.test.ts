import test from "node:test";
import assert from "node:assert/strict";
import {
  batchMatchesSearch,
  customerBatchExport,
  customerBatchRows,
  customerBatchSummary,
  customerOrderCounts,
  customerOrderState,
  filterCustomerOrders,
} from "../app/customer-order-models";
import {
  csvText,
  type Batch,
  type BatchItem,
  type Beneficiary,
  type Order,
} from "../app/models";

const batch: Batch = {
  id: "batch-a",
  customerId: "merchant-a",
  clientBatchId: "五月工资",
  createdAt: "2026-05-01T00:00:00Z",
};
const recipient: Beneficiary = {
  id: "recipient-a",
  customerId: "merchant-a",
  name: "张三",
  country: "CN",
  currency: "CNY",
  accountMasked: "****0012",
  status: "saved",
  createdBy: "merchant-a",
};
function order(id: string, patch: Partial<Order> = {}): Order {
  return {
    id,
    orderNumber: `MOCK-${id}`,
    clientOrderId: `client-${id}`,
    customerId: "merchant-a",
    batchId: batch.id,
    createdAt: "2026-05-01T00:00:00Z",
    depositStatus: "confirmed",
    conversionStatus: "recorded",
    payoutStatus: "draft",
    completionStatus: "in_progress",
    receiptStatus: "none",
    reconciled: false,
    quote: {
      id: `quote-${id}`,
      customerId: "merchant-a",
      beneficiaryId: recipient.id,
      sourceCurrency: "USDT",
      payoutCurrency: "CNY",
      sourceAmount: "10.000001",
      payoutAmount: "70.01",
      serviceFee: "1",
      channelFee: "1",
      totalDeposit: "12.000001",
      customerRate: "7",
      configVersion: "v1",
      feeRuleVersion: "v1",
      createdAt: "2026-05-01T00:00:00Z",
      expiresAt: "2026-05-01T00:05:00Z",
    },
    ...patch,
  };
}
function item(id: string, patch: Partial<BatchItem> = {}): BatchItem {
  return {
    id,
    batchId: batch.id,
    clientItemId: `reference-${id}`,
    beneficiaryId: recipient.id,
    sourceAmount: "10.000001",
    sourceCurrency: "USDT",
    status: "created",
    errors: [],
    orderId: id,
    ...patch,
  };
}

test("completion requires explicit completionStatus, never sent or a receipt", () => {
  const sent = order("sent", {
    payoutStatus: "sent",
    completionStatus: undefined,
    receiptStatus: "verified",
    receiptFileAvailable: true,
  });
  assert.equal(customerOrderState(sent).group, "attention");
  assert.equal(customerOrderState(sent).kind, "review");
  assert.match(customerOrderState(sent).detail, /尚未确认完成/);
  assert.equal(
    customerOrderState(
      order("done", {
        payoutStatus: "sent",
        completionStatus: "completed",
        receiptStatus: "none",
      }),
    ).group,
    "completed",
  );
  assert.equal(
    customerOrderState(order("waiting", { receiptStatus: "uploaded" })).group,
    "processing",
  );
});

test("unknown, failed and cancelled stay explicit even with inconsistent stale completion data", () => {
  for (const payoutStatus of ["unknown", "failed", "cancelled"]) {
    assert.equal(
      customerOrderState(
        order(payoutStatus, { payoutStatus, completionStatus: "completed" }),
      ).kind,
      payoutStatus,
    );
  }
  assert.match(
    customerOrderState(order("unknown", { payoutStatus: "unknown" })).detail,
    /禁止重复付款或重新提交/,
  );
  assert.equal(
    customerOrderState(order("deposit", { depositStatus: "exception" })).kind,
    "deposit_exception",
  );
  assert.equal(
    customerOrderState(order("awaiting", { depositStatus: "awaiting" })).kind,
    "awaiting_deposit",
  );
  assert.equal(
    customerOrderState(order("approved", { payoutStatus: "approved" })).label,
    "待付款",
  );
});

test("all history retains cancelled orders; counts and filters use actual completion", () => {
  const orders = [
    order("waiting"),
    order("completed", { payoutStatus: "sent", completionStatus: "completed" }),
    order("unknown", { payoutStatus: "unknown" }),
    order("review", {
      payoutStatus: "sent",
      completionStatus: "pending_review",
    }),
    order("cancelled", { payoutStatus: "cancelled" }),
  ];
  assert.deepEqual(customerOrderCounts(orders), {
    all: 5,
    processing: 1,
    completed: 1,
    attention: 2,
  });
  assert.equal(filterCustomerOrders(orders, [recipient], "all", "").length, 5);
  assert.deepEqual(
    filterCustomerOrders(orders, [recipient], "processing", "").map(
      (o) => o.id,
    ),
    ["waiting"],
  );
  assert.deepEqual(
    filterCustomerOrders(orders, [recipient], "completed", "").map((o) => o.id),
    ["completed"],
  );
  assert.deepEqual(
    filterCustomerOrders(orders, [recipient], "attention", "").map((o) => o.id),
    ["unknown", "review"],
  );
  assert.equal(
    filterCustomerOrders(orders, [recipient], "all", "张三").length,
    5,
  );
  assert.equal(
    filterCustomerOrders(orders, [recipient], "all", "mock-cancelled")[0].id,
    "cancelled",
  );
  assert.equal(
    filterCustomerOrders(
      orders,
      [{ ...recipient, customerId: "other", name: "别人的收款人" }],
      "all",
      "别人的收款人",
    ).length,
    0,
  );
});

test("batch rows expose completion, failure, unknown, import errors, unsubmitted, missing and cancelled separately", () => {
  const orders = [
    order("done", { payoutStatus: "sent", completionStatus: "completed" }),
    order("failed", { payoutStatus: "failed" }),
    order("unknown", { payoutStatus: "unknown" }),
    order("cancelled", { payoutStatus: "cancelled" }),
    order("review", {
      payoutStatus: "sent",
      completionStatus: "pending_review",
    }),
    order("processing"),
  ];
  const items = orders.map((o) => item(o.id));
  items.push(
    item("bad", {
      status: "error",
      orderId: undefined,
      errors: ["Invalid row fields"],
    }),
    item("draft", { status: "valid", orderId: undefined }),
    item("missing"),
  );
  const rows = customerBatchRows(batch, {
    mode: "mock",
    orders,
    batchItems: items,
    beneficiaries: [recipient],
  });
  assert.deepEqual(
    rows.map((row) => row.state.kind),
    [
      "completed",
      "failed",
      "unknown",
      "cancelled",
      "review",
      "processing",
      "invalid",
      "unsubmitted",
      "missing",
    ],
  );
  assert.match(rows[6].errors[0], /字段格式有误/);
  assert.match(rows[8].state.detail, /禁止重复提交/);
  const s = customerBatchSummary(rows);
  assert.equal(s.total, 9);
  assert.equal(s.completed, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.unknown, 1);
  assert.equal(s.invalid, 1);
  assert.equal(s.unsubmitted, 1);
  assert.equal(s.cancelled, 1);
  assert.equal(s.processing, 1);
  assert.equal(s.review, 2);
  assert.equal(s.group, "attention");
  assert.equal(s.canResume, false);
});

test("batch joins reject foreign-customer and foreign-batch orders without exposing their amounts or recipients", () => {
  const foreign = order("foreign", { customerId: "merchant-b" });
  const elsewhere = order("elsewhere", { batchId: "batch-b" });
  const rows = customerBatchRows(batch, {
    mode: "mock",
    orders: [foreign, elsewhere],
    batchItems: [item("foreign"), item("elsewhere")],
    beneficiaries: [
      { ...recipient, customerId: "merchant-b", name: "PRIVATE" },
    ],
  });
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.order, undefined);
    assert.equal(row.state.kind, "missing");
    assert.equal(row.recipient, "未识别收款人");
    assert.equal(row.targetAmount, "");
  }
  assert.equal(batchMatchesSearch(batch, rows, "PRIVATE"), false);
});

test("batch history retains associated orders when their original import rows are absent", () => {
  const rows = customerBatchRows(batch, {
    mode: "mock",
    orders: [order("legacy")],
    batchItems: [],
    beneficiaries: [recipient],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].order?.id, "legacy");
  assert.equal(rows[0].rowNumber, undefined);
  assert.equal(customerBatchSummary(rows).canResume, false);
  assert.equal(batchMatchesSearch(batch, rows, "mock-legacy"), true);
  assert.equal(batchMatchesSearch(batch, rows, "张三"), true);
  assert.equal(batchMatchesSearch(batch, rows, "五月工资"), true);
});

test("only fully unsubmitted batches with a valid row can return to quote confirmation", () => {
  const data = {
    mode: "mock",
    batchItems: [
      item("valid", { status: "valid", orderId: undefined }),
      item("invalid", {
        status: "error",
        orderId: undefined,
        errors: ["Invalid row fields"],
      }),
    ],
  };
  assert.equal(
    customerBatchSummary(customerBatchRows(batch, data)).canResume,
    true,
  );
  assert.equal(
    customerBatchSummary(
      customerBatchRows(batch, {
        ...data,
        batchItems: data.batchItems.slice(1),
      }),
    ).canResume,
    false,
  );
  assert.equal(
    customerBatchSummary(
      customerBatchRows(batch, {
        ...data,
        batchItems: [...data.batchItems, item("missing")],
      }),
    ).canResume,
    false,
  );
  assert.equal(
    customerBatchSummary(
      customerBatchRows(batch, { ...data, orders: [order("submitted")] }),
    ).canResume,
    false,
  );
});

test("terminal batches containing cancellations do not appear as processing or all completed", () => {
  const cancelled = order("cancelled", { payoutStatus: "cancelled" });
  const completed = order("completed", {
    payoutStatus: "sent",
    completionStatus: "completed",
  });
  const summarize = (orders: Order[]) =>
    customerBatchSummary(customerBatchRows(batch, { mode: "mock", orders }));
  assert.equal(summarize([cancelled]).group, "cancelled");
  assert.equal(summarize([cancelled]).label, "全部取消");
  assert.equal(summarize([completed]).group, "completed");
  assert.equal(summarize([completed, cancelled]).group, "cancelled");
  assert.equal(summarize([completed, cancelled]).label, "已结束 · 含取消");
  const mixed = customerBatchSummary(
    customerBatchRows(batch, {
      mode: "mock",
      orders: [completed],
      batchItems: [
        item("bad", {
          orderId: undefined,
          status: "error",
          errors: ["Invalid row fields"],
        }),
      ],
    }),
  );
  assert.equal(mixed.completed, 1);
  assert.equal(mixed.invalid, 1);
  assert.equal(mixed.group, "attention");
});

test("batch export preserves exact amounts, missing rows, warnings and formula-safe error text", () => {
  const orders = [order("unknown", { payoutStatus: "unknown" })];
  const rows = customerBatchRows(batch, {
    mode: "mock",
    orders,
    batchItems: [
      item("unknown"),
      item("bad", {
        orderId: undefined,
        status: "error",
        recipientName: "=HYPERLINK(1)",
        errors: ["+bad-input"],
      }),
    ],
  });
  const exported = customerBatchExport(batch, rows);
  assert.equal(exported.length, 3);
  assert.equal(exported[1][8], "10.000001");
  assert.equal(exported[1][12], "unknown");
  assert.match(exported[1][15], /禁止重复付款/);
  const csv = csvText(exported);
  assert.match(csv, /'\=HYPERLINK/);
  assert.match(csv, /'\+bad-input/);
  assert.match(csv, /导入失败/);
});
