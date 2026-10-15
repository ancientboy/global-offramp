/** No IEEE-754 arithmetic is used for monetary values. Forward conversion rounds down; reverse target quotes explicitly round principal up. */
export type Currency = "USDT" | "USDC" | "CNY" | "USD";
export const SCALE: Record<Currency, number> = {
  USDT: 6,
  USDC: 6,
  CNY: 2,
  USD: 2,
};
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function demand(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new DomainError(code, message);
}
export function units(value: string, scale: number): bigint {
  demand(
    typeof value === "string" && /^(0|[1-9]\d{0,19})(\.\d+)?$/.test(value),
    "INVALID_DECIMAL",
    "Amounts must be unsigned plain decimal strings (max 20 integer digits)",
  );
  const [a, b = ""] = value.split(".");
  demand(b.length <= scale, "PRECISION", `Maximum ${scale} decimal places`);
  return BigInt(a) * 10n ** BigInt(scale) + BigInt(b.padEnd(scale, "0") || "0");
}
export function decimal(value: bigint, scale: number): string {
  const sign = value < 0n ? "-" : "";
  const v = value < 0n ? -value : value;
  return (
    sign +
    (v / 10n ** BigInt(scale)).toString() +
    (scale
      ? "." + (v % 10n ** BigInt(scale)).toString().padStart(scale, "0")
      : "")
  );
}
export function amount(value: string, currency: Currency): string {
  return decimal(units(value, SCALE[currency]), SCALE[currency]);
}
export function add(a: string, b: string, currency: Currency): string {
  return decimal(
    units(a, SCALE[currency]) + units(b, SCALE[currency]),
    SCALE[currency],
  );
}
export function convert(
  input: string,
  from: Currency,
  to: Currency,
  rate: string,
): string {
  const result =
    (units(input, SCALE[from]) * units(rate, 8) * 10n ** BigInt(SCALE[to])) /
    (10n ** BigInt(SCALE[from]) * 100000000n);
  return decimal(result, SCALE[to]);
}
export function proportion(
  value: string,
  currency: Currency,
  rate: string,
): string {
  return decimal(
    (units(value, SCALE[currency]) * units(rate, 8)) / 100000000n,
    SCALE[currency],
  );
}
