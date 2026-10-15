import test from "node:test";
import assert from "node:assert/strict";
import {
  money,
  csvText,
  percentage,
  canResetDemoSession,
  quoteAmountInput,
  validQuoteAmount,
} from "../app/models";

test("money display preserves server decimal precision without numeric coercion", () => {
  assert.equal(money("1007.000000"), "1,007.00");
  assert.equal(money("7200.00"), "7,200.00");
  assert.equal(money("0.000001"), "0.000001");
  assert.equal(money("-0.000001"), "-0.000001");
  assert.equal(
    money("12345678901234567890.123456"),
    "12,345,678,901,234,567,890.123456",
  );
  assert.equal(money(undefined), "—");
});

test("CSV exports escape quotes, commas, and newlines in every cell", () => {
  assert.equal(
    csvText([
      ["name", "message"],
      ["A, B", 'quoted "text"\nnext'],
    ]),
    '"name","message"\n"A, B","quoted ""text""\nnext"',
  );
});

test("CSV exports neutralize formula prefixes including rejected rows and negative adjustments", () => {
  const cells = [
    "=SUM(1)",
    "+1",
    "@A1",
    "-1.00",
    ' \t=HYPERLINK("x")',
    "\r+1",
    "safe",
  ];
  const output = csvText([cells]);
  assert.equal(
    output,
    '"\'=SUM(1)","\'+1","\'@A1","\'-1.00","\' \t=HYPERLINK(""x"")","\'\r+1","safe"',
  );
});

test("rate snapshot percentages are formatted using exact strings", () => {
  assert.equal(percentage("0.20000000"), "20%");
  assert.equal(percentage("0.01234567"), "1.234567%");
  assert.equal(percentage("1.00000000"), "100%");
  assert.equal(percentage("0.00000001"), "0.000001%");
});

test("session reset control is visible only to maker in hosted session memory", () => {
  assert.equal(canResetDemoSession("maker-demo", "session-memory"), true);
  for (const persistence of ["memory", "postgres", undefined]) {
    assert.equal(canResetDemoSession("maker-demo", persistence), false);
  }
  for (const actor of [
    "customer-demo",
    "company-demo",
    "checker-demo",
    "checker-two-demo",
    "auditor-demo",
    "partner-demo",
  ] as const) {
    assert.equal(canResetDemoSession(actor, "session-memory"), false);
  }
});

test("merchant admin can reset the isolated demo session", () => {
  assert.equal(canResetDemoSession("admin-demo", "session-memory"), true);
  assert.equal(canResetDemoSession("admin-demo", "postgres"), false);
});

test("target fiat quote payload never mislabels fiat as stablecoin principal", () => {
  assert.deepEqual(quoteAmountInput("target_payout", "100000.00", "CNY"), {
    amountMode: "target_payout",
    targetAmount: "100000.00",
    payoutCurrency: "CNY",
  });
  assert.deepEqual(quoteAmountInput("target_payout", "50000.00", "USD"), {
    amountMode: "target_payout",
    targetAmount: "50000.00",
    payoutCurrency: "USD",
  });
  assert.deepEqual(quoteAmountInput("total_deposit", "1000.123456", "CNY"), {
    amountMode: "total_deposit",
    sourceAmount: "1000.123456",
  });
});

test("fiat accepts two decimals, stablecoin six, and invalid or zero amounts cannot quote", () => {
  assert.equal(validQuoteAmount("target_payout", "0.01"), true);
  assert.equal(validQuoteAmount("target_payout", "0.001"), false);
  assert.equal(validQuoteAmount("total_deposit", "0.000001"), true);
  for (const value of [
    "0",
    "0.00",
    "1e5",
    "-1",
    "NaN",
    "100,000",
    "1.1234567",
  ]) {
    assert.equal(validQuoteAmount("target_payout", value), false);
    assert.equal(validQuoteAmount("total_deposit", value), false);
  }
});
