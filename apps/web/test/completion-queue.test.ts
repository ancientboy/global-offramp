import test from "node:test";
import assert from "node:assert/strict";
import { matchesMerchantQueue } from "../app/merchant-queues";
import type { Order } from "../app/models";
test("administrator-completed orders leave reconciliation queue while optional receipts remain accessible", () => {
  const order = {
    payoutStatus: "sent",
    reconciled: false,
    completionStatus: "completed",
    receiptStatus: "none",
  } as Order;
  assert.equal(matchesMerchantQueue(order, "reconcile"), false);
  assert.equal(matchesMerchantQueue(order, "receipt"), true);
  assert.equal(matchesMerchantQueue(order, "all"), true);
  assert.equal(
    matchesMerchantQueue(
      { ...order, completionStatus: "pending_review" },
      "reconcile",
    ),
    true,
  );
  assert.equal(
    matchesMerchantQueue(
      { ...order, completionStatus: undefined },
      "reconcile",
    ),
    true,
  );
});
