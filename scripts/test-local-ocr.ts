/** All fixture values are synthetic. No customer receipt is included or transmitted. */
import assert from "node:assert/strict";
import { createWorker, OEM, PSM } from "tesseract.js";
import { resolve } from "node:path";
import { parseReceiptText } from "../apps/web/app/receipt-recognition";
async function main() {
  const worker = await createWorker(["chi_sim", "eng"], OEM.LSTM_ONLY, {
    langPath: resolve("apps/web/public/ocr"),
    cacheMethod: "none",
  });
  try {
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
      thresholding_method: "2",
    } as Parameters<typeof worker.setParameters>[0]);
    const { data } = await worker.recognize(
      resolve("apps/web/test/fixtures/synthetic-receipt.png"),
    );
    const fields = parseReceiptText(data.text, data.confidence);
    assert.equal(fields.reference, "123456789012");
    assert.equal(fields.accountTail, "1234");
    assert.equal(fields.recipientName, "测试人");
    assert.equal(fields.amount, "1000");
    assert.equal(fields.currency, "CNH");
    assert.equal(fields.payoutCurrency, "CNY");
    assert.equal(fields.payoutAmount, "1000");
    assert.equal(fields.completedAt, "2026-11-01 12:00:00");
    console.log(
      `Local synthetic OCR passed: 8 exact fields, confidence ${data.confidence}/100. No external OCR requests.`,
    );
  } finally {
    await worker.terminate();
  }
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
