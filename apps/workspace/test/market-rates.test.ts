import test from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../../../packages/core/src/store";
import { OfframpService } from "../../../packages/core/src/service";
import { ACTORS } from "../../../packages/core/src/fixtures";
import {
  MarketRatesService,
  parseEcb,
  parseKraken,
  ECB_URL,
} from "../src/market-rates";

const instant = Date.parse("2026-11-11T12:00:00Z");
const xml = `<Envelope><Cube><Cube time='2026-11-11'><Cube currency='USD' rate='1.25'/><Cube currency='CNY' rate='8'/><Cube currency='GBP' rate='0.85'/><Cube currency='MXN' rate='25'/><Cube currency='BRL' rate='6.25'/></Cube></Cube></Envelope>`;
const ticker = {
  error: [],
  result: {
    USDTZUSD: { b: ["0.99880000"], a: ["0.99900000"] },
    USDCUSD: { b: ["0.99990000"], a: ["1.00010000"] },
  },
};
const admin = { id: "test-market-admin", role: "merchant_admin" as const };
test("official reference parsing uses exact cross rates, validates dates and refuses malformed or crossed quotes", () => {
  const fx = parseEcb(xml, instant);
  assert.equal(fx.usdRates.CNY, "6.40000000");
  assert.equal(fx.usdRates.EUR, "0.80000000");
  assert.equal(fx.usdRates.USD, "1.00000000");
  assert.deepEqual(parseKraken(ticker), {
    USDT: "0.99890000",
    USDC: "1.00000000",
  });
  for (const bad of [
    xml.replace("rate='8'", "rate='NaN'"),
    xml.replace("rate='8'", "rate='0'"),
    xml.replace("2026-11-11", "2026-11-12"),
    xml.replace("2026-11-11", "2026-10-01"),
    "<!DOCTYPE x>" + xml,
    xml.replace(
      "</Cube></Cube></Envelope>",
      "<Cube currency='USD' rate='1'/></Cube></Cube></Envelope>",
    ),
  ])
    assert.throws(() => parseEcb(bad, instant));
  assert.throws(() => parseKraken({ error: ["provider error"], result: {} }));
  assert.throws(() =>
    parseKraken({
      error: [],
      result: { ...ticker.result, USDCUSD: { b: ["1.01"], a: ["1.00"] } },
    }),
  );
});
test("automatic updates preserve operator fees/margins, coalesce fetches, persist provenance and leave locked quotes unchanged", async () => {
  let now = instant,
    calls = 0;
  const store = new MemoryStore(),
    core = new OfframpService(store, () => new Date(now));
  const p = (await core.dashboard(admin)).pricingCurrent!;
  await core.publishPricing(admin, {
    expectedVersion: p.version,
    baseline: p.baseline,
    routes: { ...p.routes, CNY: { ...p.routes.CNY, adjustment: "0.10000000" } },
    serviceFee: "9.000000",
    channelFee: "3.000000",
  });
  const fetcher = (async (url: any) => {
    calls++;
    return new Response(String(url) === ECB_URL ? xml : JSON.stringify(ticker));
  }) as typeof fetch;
  const service = new MarketRatesService(store, fetcher, () => now);
  await Promise.all([service.refresh(), service.refresh()]);
  assert.equal(calls, 2);
  const current = await service.status();
  assert.equal(current.snapshot!.rates.length, 12);
  assert.equal(current.snapshot!.fxDate, "2026-11-11");
  const active = (await core.dashboard(admin)).pricingCurrent!;
  assert.equal(active.serviceFee, "9.000000");
  assert.equal(active.channelFee, "3.000000");
  assert.equal(active.routes.CNY.adjustment, "0.10000000");
  const quote = await core.createQuote(ACTORS["customer-demo"], {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDT",
    sourceAmount: "100",
  });
  const locked = (await store.read()).quotes.find((q) => q.id === quote.id)!;
  assert.equal(quote.customerRate, "6.29296000");
  assert.equal(
    locked.pricingSnapshot?.marketReference?.batchId,
    current.snapshot!.batchId,
  );
  now += 60_000;
  await service.refresh();
  const saved = (await store.read()).quotes.find((q) => q.id === quote.id)!;
  assert.deepEqual(saved, locked);
  const p2 = (await core.dashboard(admin)).pricingCurrent!;
  const changed = await core.publishPricing(admin, {
    expectedVersion: p2.version,
    baseline: p2.baseline,
    routes: p2.routes,
    serviceFee: "8.000000",
    channelFee: p2.channelFee,
  });
  assert.equal(changed.marketReference?.batchId, p2.marketReference?.batchId);
});
test("failed reference refresh never overwrites the last valid snapshot and expired references cannot price new quotes", async () => {
  let fail = false,
    now = instant;
  const store = new MemoryStore();
  const fetcher = (async (url: any) => {
    if (fail) throw Error("network");
    return new Response(String(url) === ECB_URL ? xml : JSON.stringify(ticker));
  }) as typeof fetch;
  const service = new MarketRatesService(store, fetcher, () => now);
  await service.refresh();
  const before = await store.read();
  fail = true;
  await assert.rejects(() => service.refresh());
  assert.deepEqual(await store.read(), before);
  assert.equal((await service.status()).stale, false);
  now += 31 * 60_000;
  assert.equal((await service.status()).stale, true);
  await assert.rejects(() => service.baseline(), /REFERENCE_UNAVAILABLE/);
  const fresh = new MarketRatesService(store, fetcher, () => now);
  assert.deepEqual(
    (await fresh.status()).snapshot,
    (await service.status()).snapshot,
  );
});

test("both stablecoins support all six fiat targets with exact cents, wallet freeze, idempotency and release", async () => {
  const now = () => instant,
    store = new MemoryStore(),
    core = new OfframpService(store, () => new Date(instant));
  const reference = new MarketRatesService(
    store,
    (async (url: any) =>
      new Response(
        String(url) === ECB_URL ? xml : JSON.stringify(ticker),
      )) as typeof fetch,
    now,
  );
  await reference.refresh();
  const customer = ACTORS["customer-demo"];
  for (const sourceCurrency of ["USDT", "USDC"] as const) {
    await core.depositWallet(customer, {
      customerId: "customer-1",
      currency: sourceCurrency,
      amount: "1000",
      idempotencyKey: "six-" + sourceCurrency,
    });
    for (const [currency, country] of [
      ["CNY", "CN"],
      ["USD", "US"],
      ["EUR", "FR"],
      ["GBP", "GB"],
      ["MXN", "MX"],
      ["BRL", "BR"],
    ] as const) {
      const beneficiary = await core.createBeneficiary(customer, {
        customerId: "customer-1",
        name: "Test " + currency,
        currency,
        country,
        accountToken: "six-" + sourceCurrency + currency,
        accountMasked: "**** 0123",
      });
      const input = {
        customerId: "customer-1",
        beneficiaryId: beneficiary.id,
        sourceCurrency,
        payoutCurrency: currency,
        amountMode: "target_payout",
        targetAmount: "100.01",
      };
      await assert.rejects(
        () => core.createQuote(customer, { ...input, targetAmount: "100.001" }),
        (e: any) => e.code === "PRECISION",
      );
      const quote = await core.createQuote(customer, input);
      assert.equal(quote.payoutAmount, "100.01");
      assert.ok(quote.customerRate);
      const order = await core.createOrder(customer, {
        quoteId: quote.id,
        clientOrderId: "six-" + sourceCurrency + currency,
        fundingSource: "wallet",
      });
      const repeated = await core.createOrder(customer, {
        quoteId: quote.id,
        clientOrderId: "six-" + sourceCurrency + currency,
        fundingSource: "wallet",
      });
      assert.equal(repeated.id, order.id);
      await core.cancelOrder(customer, String(order.id), {
        reason: "六币种测试结束",
      });
      const wallet = (await core.dashboard(customer)).walletBalances!.find(
        (w) => w.currency === sourceCurrency,
      )!;
      assert.equal(wallet.available, "1000.000000");
      assert.equal(wallet.frozen, "0.000000");
    }
  }
});
