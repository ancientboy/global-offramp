import { randomUUID } from "node:crypto";
import { decimal, units, DomainError } from "../../../packages/core/src/money";
import { OfframpService } from "../../../packages/core/src/service";
import {
  referenceBaseline,
  referencePricing,
} from "../../../packages/core/src/market-reference";
import type { PricingVersion, Store } from "../../../packages/core/src/types";

type Snapshot = NonNullable<PricingVersion["marketReference"]>;
const FIAT = ["USD", "CNY", "EUR", "GBP", "MXN", "BRL"] as const;
const SYSTEM = {
  id: "system-market-reference",
  role: "merchant_admin" as const,
};
const TTL = 30 * 60_000;
export const ECB_URL =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
export const KRAKEN_URL =
  "https://api.kraken.com/0/public/Ticker?pair=USDTUSD,USDCUSD";
export class MarketRateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function rate(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,8})(\.\d{1,8})?$/.test(value)
  )
    throw new MarketRateError("INVALID_RATE");
  const result = units(value, 8);
  if (result <= 0n) throw new MarketRateError("INVALID_RATE");
  return result;
}
export function parseEcb(xml: string, now: number) {
  if (xml.length > 100_000 || /<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new MarketRateError("INVALID_FX_FEED");
  const dates = [...xml.matchAll(/\btime=['"](\d{4}-\d{2}-\d{2})['"]/g)];
  if (dates.length !== 1) throw new MarketRateError("INVALID_FX_DATE");
  const date = dates[0][1],
    time = Date.parse(date + "T00:00:00Z");
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString().slice(0, 10) !== date ||
    time > now ||
    now - time > 7 * 86400000
  )
    throw new MarketRateError("STALE_FX_REFERENCE");
  const euro: Record<string, bigint> = { EUR: 100000000n };
  for (const tag of xml.matchAll(/<Cube\b([^>]+)\/>/g)) {
    const currency = /\bcurrency=['"]([A-Z]{3})['"]/.exec(tag[1])?.[1];
    if (!currency || !(FIAT as readonly string[]).includes(currency)) continue;
    if (euro[currency] !== undefined)
      throw new MarketRateError("DUPLICATE_CURRENCY");
    euro[currency] = rate(/\brate=['"]([^'"]+)['"]/.exec(tag[1])?.[1]);
  }
  for (const c of FIAT)
    if (!euro[c]) throw new MarketRateError("MISSING_CURRENCY");
  return {
    date,
    usdRates: Object.fromEntries(
      FIAT.map((c) => [c, decimal((euro[c] * 100000000n) / euro.USD, 8)]),
    ) as Snapshot["usdRates"],
  };
}
export function parseKraken(input: unknown): Snapshot["stablecoinUsd"] {
  const value = input as any;
  if (!Array.isArray(value?.error) || value.error.length || !value.result)
    throw new MarketRateError("INVALID_STABLECOIN_FEED");
  const out = {} as Snapshot["stablecoinUsd"];
  for (const asset of ["USDT", "USDC"] as const) {
    const row = value.result[asset === "USDT" ? "USDTZUSD" : "USDCUSD"];
    const bid = rate(row?.b?.[0]),
      ask = rate(row?.a?.[0]);
    if (bid > ask || bid < 50000000n || ask > 150000000n)
      throw new MarketRateError("INVALID_STABLECOIN_SPREAD");
    out[asset] = decimal((bid + ask) / 2n, 8);
  }
  return out;
}
async function boundedText(response: Response) {
  if (!response.ok || !response.body)
    throw new MarketRateError("REFERENCE_FETCH_FAILED");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 100_000) throw new MarketRateError("REFERENCE_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}
export class MarketRatesService {
  private core: OfframpService;
  private inFlight: Promise<unknown> | null = null;
  private lastError: string | null = null;
  private lastAttempt: string | null = null;
  constructor(
    store: Store,
    private fetcher: typeof fetch = fetch,
    private now = () => Date.now(),
  ) {
    this.core = new OfframpService(store, () => new Date(this.now()));
  }
  async currentPricing() {
    return (await this.core.dashboard(SYSTEM)).pricingCurrent!;
  }
  async status() {
    const p = await this.currentPricing(),
      snapshot = p.marketReference;
    return {
      snapshot: snapshot ?? null,
      stale: !snapshot || Date.parse(p.baseline.expiresAt) <= this.now(),
      expiresAt: snapshot ? p.baseline.expiresAt : null,
      pricingVersion: p.version,
      lastAttemptAt: this.lastAttempt,
      lastError: this.lastError,
    };
  }
  async baseline() {
    const s = await this.status();
    if (s.stale || !s.snapshot)
      throw new MarketRateError("REFERENCE_UNAVAILABLE");
    return referenceBaseline(s.snapshot);
  }
  refresh(): Promise<unknown> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.perform().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  private async perform() {
    this.lastAttempt = new Date(this.now()).toISOString();
    try {
      const [xml, ticker] = await Promise.all(
        [ECB_URL, KRAKEN_URL].map(async (url) =>
          boundedText(
            await this.fetcher(url, {
              signal: AbortSignal.timeout(8000),
              redirect: "error",
              headers: {
                accept:
                  url === ECB_URL ? "application/xml" : "application/json",
              },
            }),
          ),
        ),
      );
      const fetchedAt = new Date(this.now()).toISOString();
      const fx = parseEcb(xml, this.now()),
        stablecoinUsd = parseKraken(JSON.parse(ticker));
      const snapshot: Snapshot = {
        batchId: randomUUID(),
        fetchedAt,
        fxDate: fx.date,
        fxSource: "ECB",
        stablecoinSource: "Kraken",
        usdRates: fx.usdRates,
        stablecoinUsd,
        rates: (["USDT", "USDC"] as const).flatMap((sourceCurrency) =>
          FIAT.map((payoutCurrency) => ({
            sourceCurrency,
            payoutCurrency,
            referenceRate: decimal(
              (units(stablecoinUsd[sourceCurrency], 8) *
                units(fx.usdRates[payoutCurrency], 8)) /
                100000000n,
              8,
            ),
          })),
        ),
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const current = await this.currentPricing();
        try {
          await this.core.publishPricing(
            SYSTEM,
            referencePricing(snapshot, current),
            snapshot,
          );
          this.lastError = null;
          return this.status();
        } catch (e) {
          if (!(
            e instanceof DomainError &&
            e.code === "PRICING_VERSION_CONFLICT" &&
            attempt === 0
          ))
            throw e;
        }
      }
    } catch (e) {
      this.lastError =
        e instanceof MarketRateError ? e.code : "REFERENCE_FETCH_FAILED";
      throw new MarketRateError(this.lastError);
    }
  }
}
