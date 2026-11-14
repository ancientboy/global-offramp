import { decimalUnits } from "./models";
const assets: Record<string, string> = {
  usdtbsc: "USDT",
  usdttrc20: "USDT",
  usdterc20: "USDT",
  usdc: "USDC",
  usdcbase: "USDC",
};
export function validFundingQuote(payment: any, currency: string) {
  const q = payment?.cost_quote;
  try {
    if (
      !q ||
      q.version !== 1 ||
      q.feeBearer !== "customer" ||
      assets[q.settlementNetwork] !== currency ||
      q.settlementNetwork !==
        (payment.settlement_network ?? payment.pay_currency)
    )
      return null;
    if (
      ![q.payAmount, q.estimatedNet, q.estimatedCost].every(
        (n) => typeof n === "string" && /^\d{1,18}\.\d{6}$/.test(n),
      )
    )
      return null;
    if (
      decimalUnits(q.payAmount) !== decimalUnits(String(payment.pay_amount)) ||
      decimalUnits(q.estimatedNet) <= 0n ||
      decimalUnits(q.estimatedCost) < 0n ||
      decimalUnits(q.estimatedNet) + decimalUnits(q.estimatedCost) !==
        decimalUnits(q.payAmount)
    )
      return null;
    return q as {
      version: number;
      payAmount: string;
      estimatedNet: string;
      estimatedCost: string;
      settlementNetwork: string;
      quotedAt: string;
      feeBearer: string;
    };
  } catch {
    return null;
  }
}
export function fundingQuoteKey(payment: any, currency: string) {
  const q = validFundingQuote(payment, currency);
  return q
    ? [
        payment.id,
        payment.pay_currency,
        payment.pay_address,
        q.settlementNetwork,
        q.payAmount,
        q.estimatedNet,
        q.estimatedCost,
      ].join(":")
    : "";
}
