import test from "node:test";
import assert from "node:assert/strict";
import {
  parseReceiptText,
  reliableRecognition,
  validateReceiptFile,
} from "../app/receipt-recognition";
test("keeps settlement and expected payout currencies separate, both references and raw timezone", () => {
  const r = parseReceiptText(
    "状态: 成功\n结汇单号: 123456789012\n收款账户: 9876***4321\n收款方名称: 测试人\n结汇金额: 1,230.50 CNH\n预计到账金额: 1230.50 CNY\n完成时间: 2026-01-02 03:04:05\n交易订单号: 888888888888",
    88,
  );
  assert.equal(r.amount, "1230.50");
  assert.equal(r.currency, "CNH");
  assert.equal(r.payoutCurrency, "CNY");
  assert.equal(r.accountTail, "4321");
  assert.equal(r.reference, "123456789012");
  assert.equal(r.transactionReference, "888888888888");
  assert.equal(r.completedAt, "2026-01-02 03:04:05");
  assert.equal(r.recipientName, "测试人");
  assert.equal(reliableRecognition(r), true);
  assert.ok(!("rawText" in r));
});
test("no inference from standalone currency, numbers, account or successful status", () => {
  const r = parseReceiptText("成功 9999 USD 987654321 CNY/CNH", 95);
  assert.equal(r.currency, undefined);
  assert.equal(r.amount, undefined);
  assert.equal(r.accountTail, undefined);
  assert.equal(reliableRecognition(r), false);
});
test("low confidence never qualifies as reliable recognition", () => {
  assert.equal(
    reliableRecognition({
      confidence: 40,
      payoutAmount: "1",
      payoutCurrency: "CNY",
      accountTail: "1234",
      recipientName: "测试",
    }),
    false,
  );
});
test("file size and types are bounded", () => {
  assert.ok(validateReceiptFile({ size: 2097153, type: "image/png" }));
  assert.ok(validateReceiptFile({ size: 30, type: "text/html" }));
  assert.ok(validateReceiptFile({ size: 0, type: "image/png" }));
  assert.equal(
    validateReceiptFile({ size: 20, type: "application/pdf" }),
    null,
  );
});
test("Chinese OCR spacing is normalized, missing labels are not guessed", () => {
  const r = parseReceiptText(
    "结 汇 金 额 : 300 CNH\n预 计 到 账 金 额 : 300 CNY",
    90,
  );
  assert.equal(r.amount, "300");
  assert.equal(r.payoutAmount, "300");
  assert.equal(r.reference, undefined);
});
test("multiple receipt groups do not select first identity", () => {
  const r = parseReceiptText(
    "收款方名称: 测试甲\n预计到账金额: 100 CNY\n收款方名称: 测试乙\n预计到账金额: 200 CNY",
    95,
  );
  assert.equal(r.recipientName, undefined);
  assert.equal(r.payoutAmount, undefined);
});
import { parseReceiptRows } from "../app/receipt-recognition";
test("table rows with equal amounts keep separate identity and payout semantics", () => {
  const rows = parseReceiptRows(
    "预计到账金额 收款方信息 创建时间 完成时间\n10,000.00 CNY 第三方账户 | 测试甲 | 6228******1234 成功 2026-11-04 14:00:00 2026-11-04 14:01:00\n10,000.00 CNY 第三方账户 | 测试乙 | 6228******5678 成功 2026-11-04 14:02:00 2026-11-04 14:03:00",
    80,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].accountTail, "1234");
  assert.equal(rows[1].accountTail, "5678");
  assert.equal(rows[1].recipientName, "测试乙");
  assert.equal(rows[0].payoutCurrency, "CNY");
  assert.equal(rows[0].currency, undefined);
  assert.equal(rows[0].completedAt, "2026-11-04 14:01:00");
});
test("single detail receipt with two currency amounts is not a table", () => {
  assert.deepEqual(
    parseReceiptRows(
      "结汇金额: 1000.00 CNH\n预计到账金额: 1000.00 CNY\n收款方名称: 测试人",
      90,
    ),
    [],
  );
});
test("column-oriented OCR never selects first recipient from multiple identities", () => {
  const r = parseReceiptRows(
    "预计到账金额 创建时间 完成时间\n10,000.00 CNY\n10,000.00 CNY\n第三方账户 | 测试甲 | 6228******1234\n第三方账户 | 测试乙 | 6228******5678",
    90,
  );
  assert.equal(r.length, 2);
  assert.equal(r[1].recipientName, undefined);
  assert.equal(r[1].accountTail, undefined);
});
