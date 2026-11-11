import test from "node:test";
import assert from "node:assert/strict";
import type { Order } from "../app/models";
import { matchesMerchantQueue } from "../app/merchant-queues";

const order = (overrides: Partial<Order> = {}): Order => ({
  id: "mock-order",
  customerId: "mock-customer",
  clientOrderId: "mock-client",
  quote: {} as Order["quote"],
  depositStatus: "confirmed",
  conversionStatus: "pending",
  payoutStatus: "draft",
  receiptStatus: "none",
  reconciled: false,
  createdAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

test("ready matches confirmed deposits with existing manual-payout statuses", () => {
  for (const payoutStatus of [
    "draft",
    "failed",
    "approved",
    "awaiting_approval",
  ]) {
    assert.equal(matchesMerchantQueue(order({ payoutStatus }), "ready"), true);
    assert.equal(
      matchesMerchantQueue(
        order({ payoutStatus, depositStatus: "awaiting" }),
        "ready",
      ),
      false,
    );
  }
  for (const payoutStatus of [
    "unknown",
    "sent",
    "cancelled",
    "pending",
    "new-status",
  ]) {
    assert.equal(matchesMerchantQueue(order({ payoutStatus }), "ready"), false);
  }
});

test("unknown remains separate from payable, receipt and reconciliation queues", () => {
  const unknown = order({ payoutStatus: "unknown" });
  assert.equal(matchesMerchantQueue(unknown, "unknown"), true);
  for (const queue of ["ready", "receipt", "reconcile"] as const)
    assert.equal(matchesMerchantQueue(unknown, queue), false);
});

test("receipt and reconciliation intentionally overlap and close independently", () => {
  const paid = order({ payoutStatus: "sent" });
  assert.equal(matchesMerchantQueue(paid, "receipt"), true);
  assert.equal(matchesMerchantQueue(paid, "reconcile"), true);
  assert.equal(
    matchesMerchantQueue({ ...paid, receiptStatus: "uploaded" }, "receipt"),
    false,
  );
  assert.equal(
    matchesMerchantQueue({ ...paid, receiptStatus: "uploaded" }, "reconcile"),
    true,
  );
  assert.equal(
    matchesMerchantQueue({ ...paid, reconciled: true }, "reconcile"),
    false,
  );
  assert.equal(
    matchesMerchantQueue({ ...paid, reconciled: true }, "receipt"),
    true,
  );
});

test("all retains cancelled and awaiting orders without assigning them actionable queues", () => {
  for (const candidate of [
    order({ payoutStatus: "cancelled" }),
    order({ depositStatus: "awaiting" }),
  ]) {
    assert.equal(matchesMerchantQueue(candidate, "all"), true);
    for (const queue of ["ready", "unknown", "receipt", "reconcile"] as const)
      assert.equal(matchesMerchantQueue(candidate, queue), false);
  }
});
