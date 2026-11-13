import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encodeReceipt, decodeReceipt } from "../src/receipt-storage";
test("large repetitive PDF is compressed losslessly and signature bytes survive storage/reopen", async () => {
  const pdf = Buffer.from(
      "%PDF-1.7\n/ByteRange [0 42 99 100]\n" +
        "Bank receipt text and numbers\n".repeat(4000) +
        "%%EOF",
    ),
    stored = await encodeReceipt(new Uint8Array(pdf));
  assert.equal(stored.storageEncoding, "gzip");
  assert.ok(stored.data.length < pdf.length / 4);
  const read = await decodeReceipt(
    new Uint8Array(stored.data),
    stored.storageEncoding,
    pdf.length,
  );
  assert.deepEqual(Buffer.from(read), pdf);
  await assert.rejects(() =>
    decodeReceipt(stored.data, "gzip", pdf.length - 1),
  );
});
test("legacy and incompressible receipt bytes retain their original representation", async () => {
  const bytes = new Uint8Array(randomBytes(8000)),
    stored = await encodeReceipt(bytes);
  assert.equal(stored.storageEncoding, undefined);
  assert.deepEqual(
    await decodeReceipt(stored.data, undefined, bytes.length),
    bytes,
  );
});
