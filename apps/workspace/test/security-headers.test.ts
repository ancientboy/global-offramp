import test from "node:test";
import assert from "node:assert/strict";
import { workspaceHeaders } from "../src/security-headers";
test("workspace CSP hashes actual inline bootstrap scripts, restricts framing and has no unsafe-inline scripts", () => {
  const h = workspaceHeaders(
    Buffer.from(
      '<script src="/bundle.js"></script><script>self.ready=true;</script>',
    ),
  );
  assert.match(
    h["content-security-policy"]!,
    /script-src 'self' 'wasm-unsafe-eval' 'sha256-/,
  );
  assert.ok(
    !h["content-security-policy"]!.split(";")
      .find((x) => x.includes("script-src"))!
      .includes("unsafe-inline"),
  );
  assert.match(h["content-security-policy"]!, /frame-ancestors 'none'/);
  assert.match(h["strict-transport-security"], /31536000/);
});

import { ReceiptScanner } from "../src/receipt-scanner";
test("receipt scanning rejects invalid input and fails closed if engine is unavailable", async () => {
  const scanner = new ReceiptScanner("/nonexistent/huitu-test-scanner");
  await assert.rejects(
    () => scanner.scan({ dataBase64: "not-base64" }),
    (e: any) => e.code === "INVALID_FILE",
  );
  await assert.rejects(
    () =>
      scanner.scan({ dataBase64: Buffer.from("harmless").toString("base64") }),
    (e: any) => e.code === "SCAN_UNAVAILABLE",
  );
});
