import { decimal } from "../../../packages/core/src/money";
import { units } from "../../../packages/core/src/money";
import { decimal6 } from "./nowpayments";
export function depositCostQuote(
  payment: any,
  expectedNetwork: string,
  now: string,
) {
  if (payment.outcome_currency !== expectedNetwork) return null;
  try {
    const paid = decimal6(payment.pay_amount),
      net = decimal6(payment.outcome_amount);
    if (
      units(paid, 6) <= 0n ||
      units(net, 6) <= 0n ||
      units(net, 6) > units(paid, 6)
    )
      return null;
    return {
      version: 1,
      payAmount: paid,
      estimatedNet: net,
      estimatedCost: decimal(units(paid, 6) - units(net, 6), 6),
      settlementNetwork: expectedNetwork,
      quotedAt: now,
      feeBearer: "customer",
      basis: "provider_outcome_estimate",
    };
  } catch {
    return null;
  }
}
