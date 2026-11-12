import { z } from "zod";
import { CONFIG } from "./fixtures";
import { FIAT_CODES, amount, decimal, demand, units } from "./money";
import { PricingVersion, PayoutProvider } from "./types";
const value = z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,8})?$/);
const route = z
  .object({
    enabled: z.boolean(),
    adjustmentMode: z.enum(["fixed", "percentage"]),
    adjustmentDirection: z.enum(["add", "subtract"]).default("subtract"),
    adjustment: value,
  })
  .strict();
export const pricingInput = z
  .object({
    expectedVersion: z.string().min(1).max(100),
    baseline: z
      .object({
        USDT_USD: value,
        USDC_USD: value,
        USD_CNY: value,
        USD_EUR: value.optional(),
        USD_GBP: value.optional(),
        USD_MXN: value.optional(),
        USD_BRL: value.optional(),
        asOf: z.string().datetime({ offset: true }),
        expiresAt: z.string().datetime({ offset: true }),
      })
      .strict(),
    routes: z
      .object({
        CNY: route,
        USD: route,
        EUR: route.optional(),
        GBP: route.optional(),
        MXN: route.optional(),
        BRL: route.optional(),
      })
      .strict(),
    serviceFee: value,
    channelFee: value,
  })
  .strict();
export const providerInput = z
  .object({
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .optional(),
    name: z.string().trim().min(1).max(100),
    status: z.enum(["active", "disabled"]),
    scope: z.enum(["official", "third_party"]),
    routes: z.array(z.enum(FIAT_CODES)).min(1).max(6),
    isDefault: z.boolean(),
  })
  .strict();
export function checkBaseline(p: PricingVersion, now: Date) {
  const start = Date.parse(p.baseline.asOf),
    end = Date.parse(p.baseline.expiresAt);
  demand(
    start <= now.getTime() &&
      end > now.getTime() &&
      end > start &&
      end - start <= 86400000,
    "STALE_BASELINE",
    "Mock baseline must be current, not future-dated, and expire within 24 hours of its timestamp",
  );
}
export function calculatePricing(
  input: unknown,
  now: Date,
  version: string,
): PricingVersion {
  const v = pricingInput.parse(input);
  const p: PricingVersion = {
    mode: "MOCK",
    version,
    baseline: v.baseline,
    routes: v.routes,
    serviceFee: amount(v.serviceFee, "USDT"),
    channelFee: amount(v.channelFee, "USDT"),
    rates: [],
  };
  checkBaseline(p, now);
  for (const key of ["USDT_USD", "USDC_USD", "USD_CNY"] as const)
    demand(
      units(v.baseline[key], 8) > 0n &&
        units(v.baseline[key], 8) <= 100000000000000n,
      "INVALID_RATE",
      "Mock base rate must be positive and at most 1000000",
    );
  for (const sourceCurrency of ["USDT", "USDC"] as const)
    for (const payoutCurrency of FIAT_CODES) {
      const r = v.routes[payoutCurrency];
      if (!r) continue;
      const cross =
        payoutCurrency === "USD"
          ? "1"
          : v.baseline[("USD_" + payoutCurrency) as keyof typeof v.baseline];
      if (!cross && !r.enabled) continue;
      demand(
        cross,
        "REFERENCE_UNAVAILABLE",
        "Currency reference is not configured",
      );
      const base = units(
        v.baseline[sourceCurrency === "USDT" ? "USDT_USD" : "USDC_USD"],
        8,
      );
      const reference = (base * units(cross, 8)) / 100000000n;
      const adjustment = units(r.adjustment, 8);
      demand(
        r.adjustmentMode !== "percentage" || adjustment < 100000000n,
        "INVALID_ADJUSTMENT",
        "Percentage adjustment magnitude must be less than 1 (100%)",
      );
      const signedAdjustment =
        r.adjustmentDirection === "add" ? adjustment : -adjustment;
      const customer =
        r.adjustmentMode === "fixed"
          ? reference + signedAdjustment
          : (reference * (100000000n + signedAdjustment)) / 100000000n;
      demand(
        customer > 0n && customer <= reference * 2n,
        "INVALID_RATE",
        "Adjusted mock customer rate must be positive and no more than twice its reference rate",
      );
      p.rates.push({
        sourceCurrency,
        payoutCurrency,
        referenceRate: decimal(reference, 8),
        customerRate: decimal(customer, 8),
      });
    }
  return p;
}
export function initialPricing(
  config: typeof CONFIG,
  now: Date,
): PricingVersion {
  return {
    mode: "MOCK",
    version: config.version,
    baseline: {
      USDT_USD: "1.00000000",
      USDC_USD: "1.00000000",
      USD_CNY: config.routes.CNY.referenceRate,
      asOf: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86400000).toISOString(),
    },
    routes: Object.fromEntries(
      Object.entries(config.routes)
        .filter(([key]) => key === "CNY" || key === "USD")
        .map(([key, r]) => [
          key,
          {
            enabled: r.enabled,
            adjustmentMode: "fixed",
            adjustmentDirection:
              units(r.customerRate, 8) > units(r.referenceRate, 8)
                ? "add"
                : "subtract",
            adjustment: decimal(
              units(r.referenceRate, 8) > units(r.customerRate, 8)
                ? units(r.referenceRate, 8) - units(r.customerRate, 8)
                : units(r.customerRate, 8) - units(r.referenceRate, 8),
              8,
            ),
          },
        ]),
    ) as PricingVersion["routes"],
    serviceFee: config.serviceFee,
    channelFee: config.channelFee,
    rates: (["USDT", "USDC"] as const).flatMap((sourceCurrency) =>
      (["CNY", "USD"] as const).map((payoutCurrency) => ({
        sourceCurrency,
        payoutCurrency,
        referenceRate: config.routes[payoutCurrency].referenceRate,
        customerRate: config.routes[payoutCurrency].customerRate,
      })),
    ),
  };
}
export function initialProviders(): PayoutProvider[] {
  return [
    {
      id: "official-self-operated",
      name: "官方自营",
      scope: "official",
      status: "active",
      routes: [...FIAT_CODES],
      isDefault: true,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
}
