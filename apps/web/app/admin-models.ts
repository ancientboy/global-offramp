import { decimalUnits, percentage, type Order } from "./models";
export type FiatCurrency = "CNY" | "USD" | "EUR" | "MXN" | "BRL" | "GBP";
export interface PricingRoute {
  enabled: boolean;
  adjustmentMode: "fixed" | "percentage";
  adjustmentDirection?: "add" | "subtract";
  adjustment: string;
}
export interface PricingInput {
  expectedVersion: string;
  baseline: {
    USDT_USD: string;
    USDC_USD: string;
    USD_CNY: string;
    USD_EUR?: string;
    USD_GBP?: string;
    USD_MXN?: string;
    USD_BRL?: string;
    asOf: string;
    expiresAt: string;
  };
  routes: Record<FiatCurrency, PricingRoute>;
  serviceFee: string;
  channelFee: string;
}
export interface PricingVersion extends Omit<
  PricingInput,
  "expectedVersion" | "routes"
> {
  routes: Record<"CNY" | "USD", PricingRoute> &
    Partial<Record<"EUR" | "GBP" | "MXN" | "BRL", PricingRoute>>;
  version: string;
  rates: {
    sourceCurrency: string;
    payoutCurrency: string;
    referenceRate: string;
    customerRate: string;
  }[];
  publishedAt?: string;
  publishedBy?: string;
  mode: "MOCK";
}
export interface ProviderInput {
  id?: string;
  name: string;
  status: "active" | "disabled";
  scope: "official" | "third_party";
  routes: FiatCurrency[];
  isDefault: boolean;
}
export interface PayoutProvider extends ProviderInput {
  id: string;
  updatedAt?: string;
  createdAt?: string;
}
export type AdminOrder = Order & {
  orderNumber?: string;
  paymentConfirmation?: { paidAt: string; actualAmount: string };
};
export function unitsDecimal(value: bigint): string {
  return `${value / BigInt("1000000")}.${(value % BigInt("1000000")).toString().padStart(6, "0")}`;
}
export function inDateRange(value: string, from: string, to: string): boolean {
  const stamp = Date.parse(value),
    start = Date.parse(`${from}T00:00:00.000Z`),
    end = Date.parse(`${to}T00:00:00.000Z`) + 86400000;
  return Number.isFinite(stamp) && stamp >= start && stamp < end;
}
/** Gross completed-payment reporting, not profit or settlement accounting. Currency buckets never combine. */
export function operatingMetrics(
  orders: AdminOrder[],
  from: string,
  to: string,
) {
  const created = orders.filter((o) => inDateRange(o.createdAt, from, to));
  const paid = orders.filter(
    (o) =>
      o.payoutStatus === "sent" &&
      o.paymentConfirmation &&
      inDateRange(o.paymentConfirmation.paidAt, from, to),
  );
  const payouts: Record<string, bigint> = { CNY: BigInt(0), USD: BigInt(0) };
  const fees: Record<string, { service: bigint; channel: bigint }> = {
    USDT: { service: BigInt(0), channel: BigInt(0) },
    USDC: { service: BigInt(0), channel: BigInt(0) },
  };
  for (const o of paid) {
    payouts[o.quote.payoutCurrency] =
      (payouts[o.quote.payoutCurrency] ?? BigInt(0)) +
      decimalUnits(o.paymentConfirmation!.actualAmount);
    const bucket = (fees[o.quote.sourceCurrency] ??= {
      service: BigInt(0),
      channel: BigInt(0),
    });
    bucket.service += decimalUnits(o.quote.serviceFee);
    bucket.channel += decimalUnits(o.quote.channelFee);
  }
  return {
    createdCount: created.length,
    paidCount: paid.length,
    missingPaymentTimeCount: orders.filter(
      (o) => o.payoutStatus === "sent" && !o.paymentConfirmation?.paidAt,
    ).length,
    payouts: Object.entries(payouts).map(([currency, amount]) => ({
      currency,
      amount: unitsDecimal(amount),
    })),
    fees: Object.entries(fees).map(([currency, f]) => ({
      currency,
      service: unitsDecimal(f.service),
      channel: unitsDecimal(f.channel),
    })),
  };
}
export function pricingDraft(current: PricingVersion): PricingInput {
  return {
    expectedVersion: current.version,
    baseline: { ...current.baseline },
    routes: Object.fromEntries(
      (["CNY", "USD", "EUR", "GBP", "MXN", "BRL"] as const).map((key) => [
        key,
        {
          ...(current.routes[key] ?? {
            enabled: false,
            adjustmentMode: "fixed",
            adjustmentDirection: "subtract",
            adjustment: "0",
          }),
        },
      ]),
    ) as PricingInput["routes"],
    serviceFee: current.serviceFee,
    channelFee: current.channelFee,
  };
}

export function pricingAdjustmentLabel(
  route: PricingRoute | undefined,
  currency: FiatCurrency,
): string {
  if (!route) return "未配置";
  const direction = route.adjustmentDirection === "add" ? "上调 +" : "下调 −";
  return route.adjustmentMode === "percentage"
    ? `${direction}${percentage(route.adjustment)}（基准比例）`
    : `${direction}${route.adjustment} ${currency} / 稳定币`;
}

/** Signed commission adjustments use the same exact six-decimal units as payments. */
export function referralTotals(rows: { currency: string; amount: string }[]) {
  const buckets: Record<string, bigint> = {};
  for (const row of rows) {
    const negative = row.amount.startsWith("-");
    const value = decimalUnits(negative ? row.amount.slice(1) : row.amount);
    buckets[row.currency] =
      (buckets[row.currency] ?? BigInt(0)) + (negative ? -value : value);
  }
  return Object.entries(buckets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, units]) => ({
      currency,
      amount:
        units < BigInt(0) ? `-${unitsDecimal(-units)}` : unitsDecimal(units),
    }));
}
