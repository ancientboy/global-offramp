import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createPreviewWorker, type PreviewEnvironment } from "./worker";
import type { D1Database, D1Statement } from "./d1-store";
class DB implements D1Database {
  db = new DatabaseSync(":memory:");
  uncertain = false;
  constructor() {
    this.db.exec(
      "CREATE TABLE offramp_mock_state(owner_id TEXT PRIMARY KEY, revision INTEGER, document TEXT)",
    );
  }
  prepare(sql: string): D1Statement {
    let args: any[] = [];
    const self = this;
    return {
      bind(...a) {
        args = a;
        return this;
      },
      async first<T>() {
        return (self.db.prepare(sql).get(...args) ?? null) as T | null;
      },
      async run() {
        const result = self.db.prepare(sql).run(...args);
        if (self.uncertain && sql.startsWith("UPDATE")) {
          self.uncertain = false;
          throw new Error("uncertain commit");
        }
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }
}
const origin = "https://private.example";
const pdf = {
  fileName: "private.pdf",
  contentType: "application/pdf",
  dataBase64: Buffer.from("%PDF-1.4 synthetic").toString("base64"),
};
function setup() {
  const db = new DB();
  const objects = new Map<string, Uint8Array>();
  let puts = 0;
  const env: PreviewEnvironment = {
    DB: db,
    ASSETS: { fetch: async () => new Response("ok") },
    BUCKET: {
      put: async (k, v) => {
        puts++;
        objects.set(k, v);
      },
      get: async (k) =>
        objects.has(k)
          ? { arrayBuffer: async () => new Uint8Array(objects.get(k)!).buffer }
          : null,
    },
  };
  let worker = createPreviewWorker();
  async function call(
    path: string,
    cookie?: string,
    body?: unknown,
    owner = "one",
    actor = "admin-demo",
  ) {
    const headers = new Headers({
      "oai-authenticated-user-id": owner,
      "x-demo-actor": actor,
    });
    if (cookie) headers.set("cookie", cookie);
    if (body) {
      headers.set("origin", origin);
      headers.set("content-type", "application/json");
    }
    return worker.fetch(
      new Request(origin + path, {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
      }),
      env,
    );
  }
  async function boot(owner = "one") {
    const r = await call("/api/dashboard", undefined, undefined, owner);
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie")!.split(";")[0];
  }
  return {
    db,
    env,
    objects,
    call,
    boot,
    puts: () => puts,
    restart: () => {
      worker = createPreviewWorker();
    },
  };
}
test("R2 receipts are owner isolated, private downloads, dedup and no raw metadata exposure", async () => {
  const h = setup();
  const cookie = await h.boot();
  let r = await h.call("/api/receipts/upload", cookie, {
    files: [pdf, pdf],
    kind: "batch",
  });
  assert.equal(r.status, 200);
  const data: any = await r.json();
  assert.equal(data.receipts[0].id, data.receipts[1].id);
  assert.equal(h.puts(), 1);
  assert.equal(data.receipts[0].objectKey, undefined);
  const id = data.receipts[0].id;
  r = await h.call(`/api/receipts/${id}/download`, cookie);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control")!, /no-store/);
  assert.match(r.headers.get("content-disposition")!, /^attachment/);
  assert.equal(await r.text(), "%PDF-1.4 synthetic");
  assert.equal(
    (
      await h.call(
        `/api/receipts/${id}/download`,
        cookie,
        undefined,
        "one",
        "customer-demo",
      )
    ).status,
    403,
  );
  const second = await h.boot("two");
  assert.equal(
    (await h.call(`/api/receipts/${id}/download`, second, undefined, "two"))
      .status,
    404,
  );
  await h.call(
    "/api/receipts/upload",
    second,
    { files: [pdf], kind: "single" },
    "two",
  );
  assert.equal(h.objects.size, 2);
  assert.notEqual(...(Array.from(h.objects.keys()) as [string, string]));
  h.db.db.close();
});
test("uncertain D1 commit preserves object and same-hash retry safely recovers committed metadata", async () => {
  const h = setup();
  const cookie = await h.boot();
  h.db.uncertain = true;
  const first = await h.call("/api/receipts/upload", cookie, {
    files: [pdf],
    kind: "single",
  });
  assert.equal(first.status, 500);
  assert.equal(h.objects.size, 1);
  const retry = await h.call("/api/receipts/upload", cookie, {
    files: [pdf],
    kind: "single",
  });
  assert.equal(retry.status, 200);
  const list: any = await (await h.call("/api/receipts", cookie)).json();
  assert.equal(list.receipts.length, 1);
  assert.equal(h.puts(), 1);
  h.db.db.close();
});
test("malformed/bounded batches rejected before object writes and durable missing R2 is explicit", async () => {
  const h = setup();
  const cookie = await h.boot();
  const bad = await h.call("/api/receipts/upload", cookie, {
    files: [pdf, { ...pdf, fileName: "bad.png" }],
    kind: "single",
  });
  assert.equal(bad.status, 409);
  assert.equal(h.objects.size, 0);
  assert.equal(
    (
      await h.call("/api/receipts/upload", cookie, {
        files: Array(11).fill(pdf),
        kind: "single",
      })
    ).status,
    400,
  );
  h.db.db.close();
});

test("durable mode refuses uploads without private R2 binding", async () => {
  const h = setup();
  delete h.env.BUCKET;
  const cookie = await h.boot();
  const r = await h.call("/api/receipts/upload", cookie, {
    files: [pdf],
    kind: "single",
  });
  assert.equal(r.status, 503);
  assert.equal(h.objects.size, 0);
  h.db.db.close();
});

test("known full metadata capacity rejects before another R2 put", async () => {
  const h = setup();
  const cookie = await h.boot();
  await h.call("/api/receipts/upload", cookie, {
    files: [pdf],
    kind: "single",
  });
  const row = h.db.db
    .prepare("SELECT document FROM offramp_mock_state WHERE owner_id=?")
    .get("one") as { document: string };
  const state = JSON.parse(row.document);
  const original = state.privateReceipts[0];
  state.privateReceipts = Array.from({ length: 500 }, (_, i) => ({
    ...original,
    id: `receipt-${i}`,
    sha256: `hash-${i}`,
  }));
  h.db.db
    .prepare("UPDATE offramp_mock_state SET document=? WHERE owner_id=?")
    .run(JSON.stringify(state), "one");
  const before = h.puts();
  const response = await h.call("/api/receipts/upload", cookie, {
    files: [
      {
        ...pdf,
        dataBase64: Buffer.from("%PDF-1.4 new original").toString("base64"),
      },
    ],
    kind: "single",
  });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as any).error, "STORAGE_CAPACITY");
  assert.equal(h.puts(), before);
  h.db.db.close();
});

import { harness, sent } from "../packages/core/test/helpers";
test("published merchant batch persists across Worker restart and only owning customer downloads R2 original", async () => {
  const h = setup(),
    cookie = await h.boot();
  const uploaded: any = await (
    await h.call("/api/receipts/upload", cookie, {
      files: [pdf],
      kind: "batch",
    })
  ).json();
  const id = uploaded.receipts[0].id;
  const core = harness();
  await sent(core);
  await sent(core);
  const orders = (await core.store.read()).orders;
  const record = h.db.db
    .prepare("SELECT document FROM offramp_mock_state WHERE owner_id=?")
    .get("one") as { document: string };
  const state = JSON.parse(record.document);
  state.orders = orders.map((o) => ({
    ...o,
    customerId: "customer-2",
    batchId: "batch-test",
  }));
  state.batches = [
    {
      id: "batch-test",
      customerId: "customer-2",
      clientBatchId: "batch-test",
      itemIds: ["a", "b"],
      createdAt: new Date().toISOString(),
    },
  ];
  state.batchItems = orders.map((o, i) => ({
    id: i ? "b" : "a",
    batchId: "batch-test",
    clientItemId: `row-${i}`,
    beneficiaryId: o.quote.beneficiaryId,
    sourceAmount: o.quote.sourceAmount,
    sourceCurrency: "USDT",
    status: "created",
    errors: [],
    orderId: o.id,
  }));
  h.db.db
    .prepare("UPDATE offramp_mock_state SET document=? WHERE owner_id=?")
    .run(JSON.stringify(state), "one");
  const recognition: any = await (
    await h.call(`/api/receipts/${id}/recognition`, cookie, {
      fields: {},
      rows: [{ recipientName: "A" }, { recipientName: "B" }],
    })
  ).json();
  let latest: any;
  for (let i = 0; i < 2; i++) {
    const response = await h.call(`/api/receipts/${id}/link`, cookie, {
      orderId: orders[i].id,
      reason: "Verified merchant batch row",
      confirmed: true,
      selectedRowIndex: i,
      expectedRecognitionDigest: recognition.receipt.recognitionDigest,
    });
    assert.equal(response.status, 200);
    latest = await response.json();
  }
  const published = await h.call(`/api/receipts/${id}/publish-batch`, cookie, {
    customerId: "customer-2",
    batchId: "batch-test",
    expectedScopeDigest: latest.scopeDigest,
    confirmedSingleCustomer: true,
    confirmedEntireBatch: true,
    confirmedNoOtherCustomerData: true,
    purpose: "Merchant original",
  });
  assert.equal(published.status, 200);
  h.restart();
  const after = await h.boot();
  const list = await h.call(
    "/api/batches/batch-test/published-receipts",
    after,
    undefined,
    "one",
    "company-demo",
  );
  assert.equal(list.status, 200);
  const metadata: any = await list.json();
  assert.equal(metadata.receipts.length, 1);
  assert.equal(metadata.receipts[0].fileName, "receipt.pdf");
  assert.ok(!JSON.stringify(metadata).includes("private.pdf"));
  assert.ok(!JSON.stringify(metadata).includes("recognition"));
  assert.ok(!JSON.stringify(metadata).includes("objectKey"));
  const download = await h.call(
    `/api/published-receipts/${id}/download`,
    after,
    undefined,
    "one",
    "company-demo",
  );
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "%PDF-1.4 synthetic");
  assert.match(download.headers.get("cache-control")!, /no-store/);
  for (const actor of ["customer-demo", "partner-demo"]) {
    assert.equal(
      (
        await h.call(
          `/api/published-receipts/${id}/download`,
          after,
          undefined,
          "one",
          actor,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await h.call(
          "/api/batches/batch-test/published-receipts",
          after,
          undefined,
          "one",
          actor,
        )
      ).status,
      403,
    );
  }
  const other = await h.boot("two");
  assert.equal(
    (
      await h.call(
        `/api/published-receipts/${id}/download`,
        other,
        undefined,
        "two",
        "company-demo",
      )
    ).status,
    404,
  );
  h.db.db.close();
});
