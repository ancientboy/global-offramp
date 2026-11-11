import test from "node:test";
import assert from "node:assert/strict";
import { emptyHistoryFilters, filterHistory } from "../app/history-models";
import type { Order } from "../app/models";
const order = (id: string, status: string, created: string, paid?: string) =>
  ({
    id,
    orderNumber: `MOCK-${id}`,
    clientOrderId: `client-${id}`,
    customerId: "a",
    createdAt: created,
    payoutStatus: status,
    quote: {
      sourceCurrency: "USDT",
      payoutCurrency: "CNY",
      beneficiaryId: "r",
    },
    ...(paid
      ? {
          paymentConfirmation: {
            paidAt: paid,
            actualAmount: "1",
            providerReference: "MOCK-BANK",
            verification: "admin_attestation",
          },
        }
      : {}),
  }) as Order;
const rows = [
  order("sent", "sent", "2026-11-04T23:55:00Z", "2026-11-05T00:05:00Z"),
  order("cancel", "cancelled", "2026-11-05T10:00:00Z"),
  order("pending", "draft", "2026-11-05T11:00:00Z"),
];
test("history starts with every status and has no workbench queue dependency", () => {
  assert.equal(filterHistory(rows, emptyHistoryFilters, [], []).length, 3);
  assert.deepEqual(
    filterHistory(
      rows,
      { ...emptyHistoryFilters, status: "cancelled" },
      [],
      [],
    ).map((o) => o.id),
    ["cancel"],
  );
});
test("history date field distinguishes creation from actual payment and excludes missing payment", () => {
  const f = { ...emptyHistoryFilters, from: "2026-11-05", to: "2026-11-05" };
  assert.deepEqual(
    filterHistory(rows, f, [], []).map((o) => o.id),
    ["pending", "cancel"],
  );
  assert.deepEqual(
    filterHistory(rows, { ...f, timeField: "paidAt" }, [], []).map((o) => o.id),
    ["sent"],
  );
});
test("history filters currency/customer/search and searches immutable internal number", () => {
  assert.equal(
    filterHistory(
      rows,
      { ...emptyHistoryFilters, search: "MOCK-sent" },
      [],
      [],
    )[0].id,
    "sent",
  );
  assert.equal(
    filterHistory(rows, { ...emptyHistoryFilters, customerId: "other" }, [], [])
      .length,
    0,
  );
  assert.equal(
    filterHistory(rows, { ...emptyHistoryFilters, currency: "USD" }, [], [])
      .length,
    0,
  );
  assert.equal(
    filterHistory(rows, { ...emptyHistoryFilters, currency: "CNY" }, [], [])
      .length,
    3,
  );
});
