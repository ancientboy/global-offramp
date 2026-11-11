import test from "node:test";
import assert from "node:assert/strict";
import { batchProgress, batchResultLabel } from "../app/batch-progress";
test("batch progress separates completion, failure, unknown, processing and invalid rows", () => {
  const items: any[] = ["a", "b", "c", "d"].map((id) => ({
    id,
    orderId: id,
    status: "created",
  }));
  items.push({ id: "bad", status: "error" });
  const orders: any[] = [
    { id: "a", payoutStatus: "sent", completionStatus: "completed" },
    { id: "b", payoutStatus: "failed" },
    { id: "c", payoutStatus: "unknown" },
    { id: "d", payoutStatus: "sent", completionStatus: "pending_review" },
  ];
  assert.deepEqual(batchProgress(items, orders), {
    completed: 1,
    failed: 1,
    unknown: 1,
    processing: 1,
    invalid: 1,
  });
  assert.match(batchResultLabel(orders[2]), /禁止重复付款/);
  assert.match(batchResultLabel(orders[3]), /待复核/);
});
