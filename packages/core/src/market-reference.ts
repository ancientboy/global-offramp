import { FIAT_CODES } from "./money";
import type { PricingVersion } from "./types";
type Snapshot = NonNullable<PricingVersion["marketReference"]>;
export function referenceBaseline(s: Snapshot) {
  return {
    USDT_USD: s.stablecoinUsd.USDT,
    USDC_USD: s.stablecoinUsd.USDC,
    USD_CNY: s.usdRates.CNY,
    USD_EUR: s.usdRates.EUR,
    USD_GBP: s.usdRates.GBP,
    USD_MXN: s.usdRates.MXN,
    USD_BRL: s.usdRates.BRL,
    asOf: s.fetchedAt,
    expiresAt: new Date(Date.parse(s.fetchedAt) + 30 * 60000).toISOString(),
  };
}
export function referencePricing(s: Snapshot, current: PricingVersion) {
  return {
    expectedVersion: current.version,
    baseline: referenceBaseline(s),
    routes: Object.fromEntries(
      FIAT_CODES.map((c) => [
        c,
        current.routes[c] ?? {
          enabled: true,
          adjustmentMode: "fixed",
          adjustmentDirection: "subtract",
          adjustment: "0",
        },
      ]),
    ) as PricingVersion["routes"],
    serviceFee: current.serviceFee,
    channelFee: current.channelFee,
  };
}
