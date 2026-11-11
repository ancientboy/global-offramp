import test from "node:test";
import assert from "node:assert/strict";
import { ACTORS } from "../src/fixtures";
import { customer, harness, order, deposit } from "./helpers";
const admin = ACTORS["admin-demo"];
const code = (value: string) => (e: any) => e.code === value;
const input = (
  h: ReturnType<typeof harness>,
  expectedVersion = "mock-pricing-v1",
) => ({
  expectedVersion,
  baseline: {
    USDT_USD: "0.99",
    USDC_USD: "1.01",
    USD_CNY: "7.3",
    asOf: h.now.toISOString(),
    expiresAt: new Date(h.now.getTime() + 3600000).toISOString(),
  },
  routes: {
    CNY: { enabled: true, adjustmentMode: "fixed", adjustment: "0.02" },
    USD: { enabled: true, adjustmentMode: "percentage", adjustment: "0.005" },
  },
  serviceFee: "4",
  channelFee: "1.25",
});
const quote = (
  h: ReturnType<typeof harness>,
  sourceCurrency = "USDT",
  beneficiaryId = "beneficiary-cn",
) =>
  h.service.createQuote(customer, {
    customerId: "customer-1",
    beneficiaryId,
    sourceCurrency,
    sourceAmount: "100",
  });
test("pricing preview is read-only, independent asset baselines use exact fixed/percentage deductions and separated fees", async () => {
  const h = harness(),
    before = await h.store.read();
  const preview = await h.service.previewPricing(admin, input(h));
  assert.deepEqual(await h.store.read(), before);
  assert.deepEqual(
    preview.rates.map((r) => r.customerRate),
    ["7.20700000", "0.98505000", "7.35300000", "1.00495000"],
  );
  const published = await h.service.publishPricing(admin, input(h));
  const usdt = await quote(h),
    usdc = await quote(h, "USDC");
  assert.equal(usdt.customerRate, "7.20700000");
  assert.equal(usdc.customerRate, "7.35300000");
  assert.equal(usdt.payoutAmount, "720.70");
  assert.equal(usdt.totalDeposit, "105.250000");
  assert.equal(usdt.serviceFee, "4.000000");
  assert.equal(usdt.channelFee, "1.250000");
  assert.equal(usdt.configVersion, published.version);
  assert.equal(usdt.pricingSnapshot, undefined);
  const s = await h.store.read();
  assert.equal(s.quotes[0].pricingSnapshot?.baseline.USDT_USD, "0.99");
});
test("published pricing never reprices valid quotes or existing orders, and history is immutable", async () => {
  const h = harness(),
    q = await quote(h),
    o = await order(h);
  const v = await h.service.publishPricing(admin, input(h));
  const locked: any = await h.service.createOrder(customer, {
    quoteId: q.id,
    clientOrderId: "locked",
  });
  assert.equal(locked.quote.customerRate, "7.20000000");
  assert.equal(
    (await h.store.read()).orders[0].quote.customerRate,
    "7.20000000",
  );
  await assert.rejects(
    h.store.transaction((s) => {
      s.pricingHistory![0].serviceFee = "999";
    }),
    code("IMMUTABLE_RECORD"),
  );
  await assert.rejects(
    h.store.transaction((s) => {
      s.orders[0].quote.customerRate = "1";
    }),
    code("IMMUTABLE_QUOTE"),
  );
  assert.equal(
    ((await h.service.dashboard(admin)) as any).pricingCurrent.version,
    v.version,
  );
  assert.equal(
    ((await h.service.dashboard(customer)) as any).pricingHistory,
    undefined,
  );
  assert.equal(o.payoutProviderSnapshot.id, "official-self-operated");
});
test("pricing authorization, optimistic concurrency, stale/future baseline and input precision fail closed", async () => {
  const h = harness();
  for (const actor of [
    customer,
    ACTORS["partner-demo"],
    ACTORS["maker-demo"],
    ACTORS["checker-demo"],
  ])
    await assert.rejects(
      h.service.publishPricing(actor, input(h)),
      code("FORBIDDEN"),
    );
  const outcomes = await Promise.allSettled([
    h.service.publishPricing(admin, input(h)),
    h.service.publishPricing(admin, input(h)),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    (outcomes.find((x) => x.status === "rejected") as PromiseRejectedResult)
      .reason.code,
    "PRICING_VERSION_CONFLICT",
  );
  const version = ((await h.service.dashboard(admin)) as any).pricingCurrent
    .version;
  for (const patch of [
    { expiresAt: h.now.toISOString() },
    { asOf: new Date(h.now.getTime() + 1).toISOString() },
    { expiresAt: new Date(h.now.getTime() + 86400001).toISOString() },
  ])
    await assert.rejects(
      h.service.previewPricing(admin, {
        ...input(h, version),
        baseline: { ...input(h).baseline, ...patch },
      }),
      code("STALE_BASELINE"),
    );
  for (const adjustment of ["7.3", "99"])
    await assert.rejects(
      h.service.previewPricing(admin, {
        ...input(h, version),
        routes: {
          ...input(h).routes,
          CNY: { enabled: true, adjustmentMode: "fixed", adjustment },
        },
      }),
      code("INVALID_RATE"),
    );
  await assert.rejects(
    h.service.previewPricing(admin, {
      ...input(h, version),
      serviceFee: "0.0000001",
    }),
    code("PRECISION"),
  );
  h.advance(3600001);
  await assert.rejects(quote(h), code("STALE_BASELINE"));
});
test("baseline bounds quote expiry while locked funded orders can settle after pricing expires", async () => {
  const h = harness(),
    v = input(h);
  v.baseline.expiresAt = new Date(h.now.getTime() + 1000).toISOString();
  await h.service.publishPricing(admin, v);
  const o = await order(h);
  assert.equal(o.quote.expiresAt, v.baseline.expiresAt);
  await deposit(h, o);
  h.advance(2000);
  await h.service.confirmManualPayout(admin, o.id, {
    idempotencyKey: "after-expiry",
    outcome: "sent",
    actualAmount: o.quote.payoutAmount,
    paidAt: h.now.toISOString(),
    providerReference: "MOCK-entered-external-reference",
    evidence: "Synthetic payment attestation",
  });
  const stored = (await h.store.read()).orders[0];
  assert.equal(stored.paymentConfirmation?.actualAmount, o.quote.payoutAmount);
  assert.match(stored.conversion!.providerReference, /^MOCK-ALLOCATION-/);
});
test("providers are admin-only, route defaults validated, assigned server-side and snapshotted independently from referral", async () => {
  const h = harness(),
    o = await order(h),
    v = {
      name: "MOCK partner payout",
      scope: "third_party",
      status: "active",
      routes: ["CNY", "USD"],
      isDefault: true,
    };
  await assert.rejects(
    h.service.upsertPayoutProvider(customer, v),
    code("FORBIDDEN"),
  );
  await assert.rejects(
    h.service.upsertPayoutProvider(admin, { ...v, status: "disabled" }),
    code("INVALID_PROVIDER_STATUS"),
  );
  await assert.rejects(
    h.service.upsertPayoutProvider(admin, { ...v, routes: ["CNY"] }),
    code("DEFAULT_PROVIDER_REQUIRED"),
  );
  await assert.rejects(
    h.service.upsertPayoutProvider(admin, { ...v, routes: ["CNY", "CNY"] }),
    code("INVALID_PROVIDER_ROUTE"),
  );
  const provider = await h.service.upsertPayoutProvider(admin, v),
    next = await order(h);
  assert.equal(next.payoutProviderSnapshot.id, provider.id);
  assert.equal(next.quote.partnerId, undefined);
  const s = await h.store.read();
  assert.equal(s.orders[1].quote.partnerId, "partner-1");
  assert.equal(
    s.orders[0].payoutProviderSnapshot?.id,
    "official-self-operated",
  );
  assert.match(o.orderNumber, /^MOCK-20260101-000001$/);
  assert.match(next.orderNumber, /000002$/);
  await h.service.upsertPayoutProvider(admin, {
    ...v,
    id: provider.id,
    name: "Renamed provider",
  });
  assert.equal(
    (await h.store.read()).orders[1].payoutProviderSnapshot?.name,
    v.name,
  );
  await assert.rejects(
    h.store.transaction((s) => {
      s.orders[0].payoutProviderSnapshot!.name = "tamper";
    }),
    code("IMMUTABLE_PROVIDER"),
  );
  await assert.rejects(
    h.service.createOrder(customer, {
      quoteId: (await quote(h)).id,
      clientOrderId: "injection",
      payoutProviderId: provider.id,
    }),
  );
  const partner = (await h.service.dashboard(ACTORS["partner-demo"])) as any;
  assert.equal(partner.payoutProviders, undefined);
  assert.equal(partner.pricingCurrent, undefined);
  assert.equal(partner.orders, undefined);
});

test("bootstrap pricing survives service restart and expires rather than silently refreshing", async () => {
  const h = harness();
  const first = (await h.service.dashboard(admin)) as any;
  const before = (await h.store.read()).pricingHistory!;
  assert.equal(before.length, 1);
  assert.equal(first.pricingCurrent.baseline.asOf, h.now.toISOString());
  h.advance(86400001);
  const { OfframpService } = await import("../src/service");
  const restarted = new OfframpService(h.store, () => h.now);
  const after = (await restarted.dashboard(admin)) as any;
  assert.deepEqual(after.pricingCurrent, first.pricingCurrent);
  assert.equal(after.pricingBaselineExpired, true);
  assert.equal(after.walletRates[0].stale, true);
  assert.equal(after.walletRates[0].baselineSource, "MOCK");
  await assert.rejects(
    restarted.createQuote(customer, {
      customerId: "customer-1",
      beneficiaryId: "beneficiary-cn",
      sourceCurrency: "USDT",
      sourceAmount: "100",
    }),
    code("STALE_BASELINE"),
  );
  await restarted.publishPricing(admin, input(h));
  assert.equal((await h.store.read()).pricingHistory!.length, 2);
});

test("explicit add direction supports fixed and percentage uplift with exact math and upper guard", async () => {
  const h = harness(),
    v = input(h);
  const add = {
    ...v,
    routes: {
      CNY: { ...v.routes.CNY, adjustmentDirection: "add" },
      USD: { ...v.routes.USD, adjustmentDirection: "add" },
    },
  };
  const result = await h.service.publishPricing(admin, add);
  assert.deepEqual(
    result.rates.map((r) => r.customerRate),
    ["7.24700000", "0.99495000", "7.39300000", "1.01505000"],
  );
  assert.equal(result.routes.CNY.adjustmentDirection, "add");
  assert.equal((await quote(h)).customerRate, "7.24700000");
  await assert.rejects(
    h.service.previewPricing(admin, {
      ...add,
      expectedVersion: result.version,
      routes: { ...add.routes, CNY: { ...add.routes.CNY, adjustment: "99" } },
    }),
    code("INVALID_RATE"),
  );
  await assert.rejects(
    h.service.previewPricing(admin, {
      ...add,
      expectedVersion: result.version,
      routes: { ...add.routes, USD: { ...add.routes.USD, adjustment: "1" } },
    }),
    code("INVALID_ADJUSTMENT"),
  );
  await assert.rejects(
    h.service.previewPricing(admin, {
      ...add,
      expectedVersion: result.version,
      routes: {
        ...add.routes,
        CNY: { ...add.routes.CNY, adjustment: "-0.02" },
      },
    }),
  );
});
