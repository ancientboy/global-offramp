import test from "node:test";
import assert from "node:assert/strict";
import {
  inDateRange,
  operatingMetrics,
  referralTotals,
  pricingDraft,
  pricingAdjustmentLabel,
  type AdminOrder,
  type PricingVersion,
} from "../app/admin-models";
const order = (overrides: Partial<AdminOrder> = {}): AdminOrder => ({
  id: "o",
  customerId: "c",
  clientOrderId: "r",
  createdAt: "2026-11-04T23:59:59Z",
  depositStatus: "confirmed",
  conversionStatus: "recorded",
  payoutStatus: "sent",
  receiptStatus: "none",
  reconciled: false,
  quote: {
    id: "q",
    customerId: "c",
    beneficiaryId: "b",
    sourceCurrency: "USDT",
    payoutCurrency: "CNY",
    sourceAmount: "100",
    payoutAmount: "700",
    serviceFee: "0.100001",
    channelFee: "0.200002",
    totalDeposit: "100.300003",
    customerRate: "7",
    configVersion: "v",
    feeRuleVersion: "v",
    createdAt: "2026-11-04T23:59:59Z",
    expiresAt: "2026-11-05T00:09:59Z",
  },
  paymentConfirmation: {
    actualAmount: "700.01",
    providerReference: "demo",
    verification: "admin_attestation",
    paidAt: "2026-11-05T00:00:00Z",
  },
  ...overrides,
});
test("UTC range includes both selected dates and excludes following midnight", () => {
  assert.equal(
    inDateRange("2026-11-05T23:59:59.999Z", "2026-11-05", "2026-11-05"),
    true,
  );
  assert.equal(
    inDateRange("2026-11-06T00:00:00Z", "2026-11-05", "2026-11-05"),
    false,
  );
  assert.equal(inDateRange("invalid", "2026-11-05", "2026-11-05"), false);
});
test("payments and fees use paidAt, created orders use createdAt, unknown excluded", () => {
  const metrics = operatingMetrics(
    [
      order(),
      order({ payoutStatus: "unknown" }),
      order({ paymentConfirmation: undefined }),
      order({
        createdAt: "2026-11-05T12:00:00Z",
        payoutStatus: "pending",
        paymentConfirmation: undefined,
      }),
    ],
    "2026-11-05",
    "2026-11-05",
  );
  assert.equal(metrics.createdCount, 1);
  assert.equal(metrics.paidCount, 1);
  assert.deepEqual(metrics.payouts, [
    { currency: "CNY", amount: "700.010000" },
    { currency: "USD", amount: "0.000000" },
  ]);
  assert.equal(metrics.fees[0].service, "0.100001");
});
test("currency buckets remain separate and decimal sums are exact", () => {
  const a = order(),
    b = order({
      quote: { ...a.quote, sourceCurrency: "USDC", payoutCurrency: "USD" },
      paymentConfirmation: {
        actualAmount: "0.2",
        providerReference: "demo",
        verification: "admin_attestation",
        paidAt: "2026-11-05T12:00:00Z",
      },
    });
  const m = operatingMetrics([a, a, b], "2026-11-05", "2026-11-05");
  assert.equal(m.payouts[0].amount, "1400.020000");
  assert.equal(m.payouts[1].amount, "0.200000");
  assert.equal(m.fees[0].service, "0.200002");
  assert.equal(m.fees[1].channel, "0.200002");
});
test("pricing drafts isolate mutations from published version and preserve concurrency token", () => {
  const v: PricingVersion = {
    version: "v1",
    baseline: {
      USDT_USD: "1",
      USDC_USD: "1",
      USD_CNY: "7",
      asOf: "2026-11-05T00:00:00Z",
      expiresAt: "2026-11-06T00:00:00Z",
    },
    routes: {
      CNY: { enabled: true, adjustmentMode: "fixed", adjustment: "0.1" },
      USD: { enabled: true, adjustmentMode: "percentage", adjustment: "0.005" },
    },
    serviceFee: "1",
    channelFee: "2",
    rates: [],
    mode: "MOCK",
  };
  const d = pricingDraft(v);
  d.routes.CNY.adjustment = "0.2";
  d.baseline.USD_CNY = "8";
  assert.equal(v.routes.CNY.adjustment, "0.1");
  assert.equal(v.baseline.USD_CNY, "7");
  assert.equal(d.expectedVersion, "v1");
});

test("adjustment direction and units are explicit for fixed and percentage settings", () => {
  assert.equal(
    pricingAdjustmentLabel(
      {
        enabled: true,
        adjustmentMode: "fixed",
        adjustmentDirection: "add",
        adjustment: "0.05",
      },
      "CNY",
    ),
    "上调 +0.05 CNY / 稳定币",
  );
  assert.equal(
    pricingAdjustmentLabel(
      {
        enabled: true,
        adjustmentMode: "percentage",
        adjustmentDirection: "subtract",
        adjustment: "0.005",
      },
      "USD",
    ),
    "下调 −0.5%（基准比例）",
  );
  assert.equal(
    pricingAdjustmentLabel(
      { enabled: true, adjustmentMode: "fixed", adjustment: "0" },
      "USD",
    ),
    "下调 −0 USD / 稳定币",
  );
});

test("legacy sent records without payment time are flagged, never assigned a guessed payment date or amount", () => {
  const old = order({
    createdAt: "2020-01-01T00:00:00Z",
    paymentConfirmation: undefined,
  });
  const m = operatingMetrics(
    [old, order({ payoutStatus: "pending", paymentConfirmation: undefined })],
    "2026-11-05",
    "2026-11-05",
  );
  assert.equal(m.missingPaymentTimeCount, 1);
  assert.equal(m.paidCount, 0);
  assert.equal(m.payouts[0].amount, "0.000000");
  assert.equal(m.fees[0].service, "0.000000");
});

test("referral totals preserve currency and signed exact adjustments", () => {
  assert.deepEqual(
    referralTotals([
      { currency: "USDT", amount: "0.100001" },
      { currency: "USDT", amount: "-0.200002" },
      { currency: "USDC", amount: "1.25" },
    ]),
    [
      { currency: "USDC", amount: "1.250000" },
      { currency: "USDT", amount: "-0.100001" },
    ],
  );
});
