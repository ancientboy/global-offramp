import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const payment = page.slice(
  page.indexOf('{page === "payment" && role === "customer" && ('),
  page.indexOf('{(page === "recipients" ||'),
);
const confirmation = payment.slice(
  payment.indexOf("step === 2 && quote ? ("),
  payment.indexOf("step === 3 && order && order.id === selected ? ("),
);

test("exchange success requires the selected submitted order, not a stale order after interrupted confirmation", () => {
  assert.match(payment, /step === 3 && order && order\.id === selected \? \(/);
  assert.doesNotMatch(payment, /\) : order \? \(/);
  assert.match(payment, /请重新核对结汇信息/);
  assert.match(payment, /返回填写结汇/);
});

test("confirmation recipient and available currency remain tied to the quote snapshot", () => {
  assert.ok(confirmation.length > 0);
  assert.match(confirmation, /b\.id === quote\.beneficiaryId/);
  assert.doesNotMatch(confirmation, /recipient\?\./);
  assert.match(confirmation, /w\.currency === quote\.sourceCurrency/);
  assert.match(
    confirmation,
    /!checked \|\|[\s\S]*remaining === 0 \|\|[\s\S]*!enoughBalance/,
  );
  assert.match(confirmation, /未知付款结果保持冻结/);
});

test("batch history and receipt access live outside the staged exchange form", () => {
  assert.match(payment, /!visibleBatch \? \(/);
  assert.match(payment, /\) : batchPreview \? \(/);
  assert.match(payment, /返回校验结果/);
  assert.match(payment, /更换文件 \/ 修改后重传/);
  assert.match(payment, /修改错误行并重新上传/);
  assert.match(payment, /前往订单查看/);
  assert.doesNotMatch(payment, /data\.batches\.map|<PublishedReceipts/);
  assert.match(
    payment,
    /!batchChecked \|\|[\s\S]*!batchEnough \|\|[\s\S]*!batchRemaining/,
  );
});
