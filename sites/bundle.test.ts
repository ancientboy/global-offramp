import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Build tooling intentionally lives in native Node ESM.
import { bundleWorker } from "../scripts/build-sites.mjs";

test("production Worker is standalone ESM, exports fetch, and runs bundled core without Node imports", async () => {
  const { code, metafile } = await bundleWorker();
  for (const output of Object.values(metafile.outputs) as any[])
    assert.deepEqual(output.imports, []);
  assert.doesNotMatch(code, /(?:from\s*["']node:|require\s*\(|process\.env)/);
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(code).toString("base64")
  );
  assert.deepEqual(Object.keys(module), ["default"]);
  assert.equal(typeof module.default.fetch, "function");
  const env = { ASSETS: { fetch: async () => new Response("static") } };
  const origin = "https://preview.example";
  const initial = await module.default.fetch(
    new Request(origin + "/api/dashboard", {
      headers: { "x-demo-actor": "maker-demo" },
    }),
    env,
  );
  assert.equal(initial.status, 200);
  const cookie = initial.headers.get("set-cookie").split(";", 1)[0];
  const seeded = await module.default.fetch(
    new Request(origin + "/api/demo/scenario", {
      method: "POST",
      headers: {
        "x-demo-actor": "maker-demo",
        origin,
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ idempotencyKey: "bundle" }),
    }),
    env,
  );
  assert.equal(seeded.status, 200, await seeded.clone().text());
  assert.equal((await seeded.json()).orderIds.length, 3);
  const partner = await module.default.fetch(
    new Request(origin + "/api/dashboard", {
      headers: { "x-demo-actor": "partner-demo", cookie },
    }),
    env,
  );
  assert.equal((await partner.json()).commissions.length, 1);
  const batch = await module.default.fetch(
    new Request(origin + "/api/batches", {
      method: "POST",
      headers: {
        "x-demo-actor": "maker-demo",
        origin,
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        customerId: "customer-1",
        clientBatchId: "bundled-csv",
        csv: "clientItemId,beneficiaryId,sourceCurrency,sourceAmount\nline-one,beneficiary-cn,USDT,100\n",
      }),
    }),
    env,
  );
  assert.equal(batch.status, 200, await batch.clone().text());
  assert.equal((await batch.json()).items[0].status, "valid");
});
