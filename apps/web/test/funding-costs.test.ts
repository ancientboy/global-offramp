import test from "node:test";
import assert from "node:assert/strict";
import { depositCostQuote } from "../../workspace/src/deposit-quote";
import { validFundingQuote, fundingQuoteKey } from "../app/funding-costs";
test("deposit cost quote is the complete net difference with conservative micro precision, not an additional withdrawal fee", () => {
  const q = depositCostQuote(
    {
      pay_amount: "100",
      outcome_amount: "95.2923176",
      outcome_currency: "usdtbsc",
    },
    "usdtbsc",
    "2026-11-14T12:00:00Z",
  )!;
  assert.equal(q.estimatedCost, "4.707683");
  assert.equal(q.estimatedNet, "95.292317");
  const p = {
    id: "test",
    pay_currency: "usdttrc20",
    settlement_network: "usdtbsc",
    pay_amount: "100",
    pay_address: "isolated-address",
    cost_quote: q,
  };
  assert(validFundingQuote(p, "USDT"));
  assert.equal(validFundingQuote(p, "USDC"), null);
  assert.equal(
    validFundingQuote(
      { ...p, cost_quote: { ...q, estimatedCost: "0.000000" } },
      "USDT",
    ),
    null,
  );
  assert.notEqual(
    fundingQuoteKey(p, "USDT"),
    fundingQuoteKey(
      {
        ...p,
        cost_quote: {
          ...q,
          estimatedNet: "94.000000",
          estimatedCost: "6.000000",
        },
      },
      "USDT",
    ),
  );
  assert.equal(
    depositCostQuote(
      { pay_amount: "100", outcome_amount: "99", outcome_currency: "usdcbase" },
      "usdtbsc",
      "now",
    ),
    null,
  );
  for (const net of ["0", "101", "NaN", "-1", "1e2"]) {
    assert.equal(
      depositCostQuote(
        { pay_amount: "100", outcome_amount: net, outcome_currency: "usdtbsc" },
        "usdtbsc",
        "now",
      ),
      null,
    );
  }
});
