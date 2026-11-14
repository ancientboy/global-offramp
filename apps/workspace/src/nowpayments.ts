import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "./auth";
export interface DepositNetwork {
  id: string;
  asset: "USDT" | "USDC";
  label: string;
}
// These are payment-provider tickers, not arbitrary token names. Enable only after merchant verification.
export const DEPOSIT_NETWORKS: DepositNetwork[] = [
  { id: "usdttrc20", asset: "USDT", label: "TRON · TRC20" },
  { id: "usdtbsc", asset: "USDT", label: "BNB Smart Chain · BEP20" },
  { id: "usdterc20", asset: "USDT", label: "Ethereum · ERC20" },
  { id: "usdc", asset: "USDC", label: "Ethereum · ERC20" },
  { id: "usdcbase", asset: "USDC", label: "Base" },
];
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  return value;
}
export function verifyIpn(
  raw: string,
  signature: string | null,
  secret: string,
) {
  if (
    Buffer.byteLength(raw) > 65536 ||
    !signature ||
    !/^[a-fA-F0-9]{128}$/.test(signature)
  )
    throw new HttpError(401, "INVALID_IPN_SIGNATURE");
  const value = JSON.parse(raw);
  if (!value || Array.isArray(value) || typeof value !== "object")
    throw new HttpError(400, "INVALID_IPN");
  const canonical = JSON.stringify(sortKeys(value));
  const expected = createHmac("sha512", secret).update(canonical).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex")))
    throw new HttpError(401, "INVALID_IPN_SIGNATURE");
  return {
    value,
    digest: createHash("sha256").update(canonical).digest("hex"),
  };
}
export function paymentId(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw new HttpError(502, "INVALID_PROVIDER_RESPONSE");
  if (!/^[0-9]{1,30}$/.test(String(value)))
    throw new HttpError(502, "INVALID_PROVIDER_RESPONSE");
  return String(value);
}
export function decimal6(value: unknown): string {
  const s = String(value);
  if (!/^\d{1,18}(\.\d{1,18})?$/.test(s))
    throw new HttpError(502, "INVALID_PROVIDER_AMOUNT");
  const [whole, fraction = ""] = s.split(".");
  return BigInt(whole).toString() + "." + (fraction + "000000").slice(0, 6);
}
export class NowPayments {
  readonly base: string;
  constructor(
    readonly apiKey: string,
    readonly ipnSecret: string,
    readonly sandbox = false,
    readonly fetcher: typeof fetch = fetch,
  ) {
    if (!apiKey || !ipnSecret) throw Error("NOWPayments keys required");
    this.base = sandbox
      ? "https://api-sandbox.nowpayments.io/v1"
      : "https://api.nowpayments.io/v1";
  }
  async request(path: string, body?: unknown) {
    let r: Response;
    try {
      r = await this.fetcher(this.base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-api-key": this.apiKey,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
        redirect: "error",
      });
    } catch {
      throw new HttpError(503, "PAYMENT_PROVIDER_UNAVAILABLE");
    }
    if (!r.ok) throw new HttpError(503, "PAYMENT_PROVIDER_UNAVAILABLE");
    const text = await r.text();
    if (text.length > 1024 * 1024)
      throw new HttpError(502, "INVALID_PROVIDER_RESPONSE");
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(502, "INVALID_PROVIDER_RESPONSE");
    }
  }
  async minimum(network: string) {
    const v = await this.request(
      "/min-amount?currency_from=" +
        encodeURIComponent(network) +
        "&currency_to=" +
        encodeURIComponent(network),
    );
    return decimal6(v.min_amount);
  }
  async create(id: string, amount: string, network: string, callback: string) {
    return this.request("/payment", {
      price_amount: amount,
      price_currency: network,
      pay_currency: network,
      order_id: id,
      order_description: "Huitu account deposit",
      ipn_callback_url: callback,
      is_fixed_rate: false,
      is_fee_paid_by_user: false,
    });
  }
  async get(id: string) {
    return this.request("/payment/" + paymentId(id));
  }
}
