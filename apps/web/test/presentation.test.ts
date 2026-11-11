import test from "node:test";
import assert from "node:assert/strict";
import {
  money,
  csvText,
  percentage,
  canResetDemoSession,
  quoteAmountInput,
  validQuoteAmount,
  decimalUnits,
  hasWalletFunds,
  recipientUsable,
  batchErrorLabel,
  canQuickMockConfirm,
  type Order,
} from "../app/models";

test("quick MOCK confirmation is limited to funded official normal states", () => {
  const o = {
    depositStatus: "confirmed",
    payoutStatus: "draft",
    payoutProviderSnapshot: { scope: "official", status: "active" },
  } as Order;
  assert.equal(canQuickMockConfirm(o), true);
  for (const payoutStatus of ["approved", "awaiting_approval"])
    assert.equal(canQuickMockConfirm({ ...o, payoutStatus }), true);
  for (const payoutStatus of ["unknown", "failed", "sent", "cancelled"])
    assert.equal(canQuickMockConfirm({ ...o, payoutStatus }), false);
  assert.equal(canQuickMockConfirm({ ...o, depositStatus: "awaiting" }), false);
  assert.equal(
    canQuickMockConfirm({ ...o, payoutProviderSnapshot: undefined }),
    false,
  );
  assert.equal(
    canQuickMockConfirm({
      ...o,
      payoutProviderSnapshot: {
        ...o.payoutProviderSnapshot!,
        scope: "third_party",
      },
    }),
    false,
  );
});

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

test("wallet display comparisons retain six decimals and reject malformed values", () => {
  assert.equal(
    decimalUnits("9007199254740993.000001"),
    BigInt("9007199254740993000001"),
  );
  assert.equal(hasWalletFunds("1000.000001", "1000.000001"), true);
  assert.equal(hasWalletFunds("1000.000000", "1000.000001"), false);
  assert.equal(hasWalletFunds(undefined, "1"), false);
  assert.equal(hasWalletFunds("NaN", "1"), false);
  assert.throws(() => decimalUnits("1.0000001"));
});

test("saved and legacy saved recipients are selectable without claiming verification", () => {
  for (const status of ["saved", "approved", "pending"])
    assert.equal(recipientUsable(status), true);
  for (const status of ["suspended", "unknown", ""])
    assert.equal(recipientUsable(status), false);
  assert.equal(
    batchErrorLabel("Beneficiary unavailable or outside customer scope"),
    "收款账户不存在、已停用，或不属于当前客户",
  );
  assert.equal(
    batchErrorLabel("Recipient unavailable or belongs to another customer"),
    "收款账户不存在、已停用，或不属于当前客户",
  );
});
