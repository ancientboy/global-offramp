import test from "node:test";
import assert from "node:assert/strict";
import {
  displayDate,
  providerQueue,
  adminOrderTasks,
  recentWithdrawalAddresses,
} from "../app/experience-models";
import type { Order } from "../app/models";
test("display timestamps are identical across user and operator machine time zones without changing instant", () => {
  const original = process.env.TZ;
  try {
    for (const tz of ["Asia/Shanghai", "America/Sao_Paulo", "UTC"]) {
      process.env.TZ = tz;
      assert.equal(
        displayDate("2026-11-14T01:02:03Z"),
        "2026/11/14 09:02:03 北京时间",
      );
    }
  } finally {
    if (original) process.env.TZ = original;
    else delete process.env.TZ;
  }
  assert.equal(displayDate("invalid"), "—");
});
test("provider queues separate blocked funds, eligible payments and unknown outcomes", () => {
  assert.equal(
    providerQueue({ canRecordPayment: false, payoutStatus: "draft" }),
    "waiting",
  );
  assert.equal(
    providerQueue({ canRecordPayment: true, payoutStatus: "draft" }),
    "ready",
  );
  assert.equal(
    providerQueue({ canRecordPayment: false, payoutStatus: "unknown" }),
    "unknown",
  );
  assert.equal(
    providerQueue({ canRecordPayment: false, payoutStatus: "sent" }),
    "sent",
  );
});
test("admin ready tasks require reserved wallet funds; unknown and unreconciled sent outcomes stay in review", () => {
  const base = {
    id: "a",
    createdAt: "2026-11-12T00:00:00Z",
    depositStatus: "confirmed",
    fundingSource: "wallet",
    walletFundingStatus: "reserved",
    payoutStatus: "draft",
  } as Order;
  const tasks = adminOrderTasks(
    [
      base,
      { ...base, id: "b", walletFundingStatus: "released" },
      { ...base, id: "c", payoutStatus: "unknown" },
      {
        ...base,
        id: "d",
        payoutStatus: "sent",
        completionStatus: "pending_review",
      },
    ],
    Date.parse("2026-11-14T00:00:00Z"),
  );
  assert.deepEqual(
    tasks.ready.map((o) => o.id),
    ["a"],
  );
  assert.deepEqual(
    tasks.review.map((o) => o.id),
    ["c", "d"],
  );
  assert.equal(tasks.overdue.length, 3);
});
test("withdrawal address suggestions only reuse completed same-asset same-network outgoing destinations", () => {
  const rows = [
    {
      kind: "refund",
      currency: "USDT",
      network: "usdttrc20",
      status: "completed",
      destination: "T-wallet",
    },
    {
      kind: "refund",
      currency: "USDT",
      network: "usdttrc20",
      status: "rejected",
      destination: "bad",
    },
    {
      kind: "refund",
      currency: "USDC",
      network: "usdcbase",
      status: "completed",
      destination: "base-wallet",
    },
    {
      kind: "provider_settlement",
      currency: "USDT",
      network: "usdttrc20",
      status: "completed",
      destination: "provider",
    },
  ];
  assert.deepEqual(recentWithdrawalAddresses([...rows, rows[0]], "USDT"), [
    "T-wallet",
  ]);
  assert.deepEqual(recentWithdrawalAddresses(rows, "USDC"), ["base-wallet"]);
});
