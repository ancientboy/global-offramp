import assert from "node:assert/strict";
import test from "node:test";
import {
  BoundedMemoryStore,
  createPreviewWorker,
  PREVIEW_LIMITS,
  type PreviewEnvironment,
} from "./worker";

const origin = "https://private-preview.example";
const env: PreviewEnvironment = {
  ASSETS: {
    fetch: async (request) =>
      new Response("asset:" + new URL(request.url).pathname),
  },
};
type Worker = ReturnType<typeof createPreviewWorker>;
function request(
  path: string,
  options: {
    actor?: string;
    cookie?: string;
    body?: unknown;
    method?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const method =
    options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers = new Headers({
    "x-demo-actor": options.actor ?? "maker-demo",
    ...options.headers,
  });
  if (options.cookie) headers.set("cookie", options.cookie);
  if (method === "POST") {
    if (!headers.has("origin")) headers.set("origin", origin);
    headers.set("content-type", "application/json");
  }
  return new Request(origin + path, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
  });
}
async function call(
  worker: Worker,
  path: string,
  options: Parameters<typeof request>[1] = {},
) {
  const response = await worker.fetch(request(path, options), env);
  const body = (await response.json()) as any;
  return { response, body };
}
async function bootstrap(worker: Worker, actor = "maker-demo") {
  const result = await call(worker, "/api/dashboard", { actor });
  assert.equal(result.response.status, 200);
  const cookie = result.response.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  return { ...result, cookie };
}
async function seed(
  worker: Worker,
  cookie: string,
  idempotencyKey = "preview-one",
) {
  return call(worker, "/api/demo/scenario", {
    cookie,
    body: { idempotencyKey },
  });
}

test("health is stateless, explicit and safe during concurrent initial dashboard load", async () => {
  const worker = createPreviewWorker();
  const [health, dashboard] = await Promise.all([
    call(worker, "/api/health"),
    bootstrap(worker),
  ]);
  assert.equal(health.response.headers.get("set-cookie"), null);
  assert.equal(health.body.persistence, "session-memory");
  assert.equal(health.body.mode, "MOCK");
  assert.equal(health.body.realExecutionEnabled, false);
  assert.equal(health.body.volatile, true);
  assert.equal(health.body.ttlSeconds, 1800);
  assert.match(
    dashboard.response.headers.get("set-cookie")!,
    /HttpOnly; Secure; SameSite=Strict/,
  );
  assert.match(dashboard.cookie, /^__Host-offramp-preview=[a-f0-9]{64}$/);
  assert.match(dashboard.response.headers.get("cache-control")!, /no-store/);
  assert.equal((await seed(worker, dashboard.cookie)).response.status, 200);
});

test("two browser sessions remain isolated while same-cookie state persists across requests", async () => {
  const worker = createPreviewWorker();
  const [a, b] = await Promise.all([bootstrap(worker), bootstrap(worker)]);
  assert.notEqual(a.cookie, b.cookie);
  assert.equal((await seed(worker, a.cookie)).response.status, 200);
  assert.equal(
    (await call(worker, "/api/dashboard", { cookie: a.cookie })).body.orders
      .length,
    3,
  );
  assert.equal(
    (await call(worker, "/api/dashboard", { cookie: b.cookie })).body.orders
      .length,
    0,
  );
  assert.equal(
    (
      await call(worker, "/api/dashboard", { cookie: a.cookie })
    ).response.headers.get("set-cookie"),
    null,
  );
});

test("the exact core scope and fixture actor rules remain server-side", async () => {
  const worker = createPreviewWorker();
  const { cookie } = await bootstrap(worker);
  await seed(worker, cookie);
  const personal = await call(worker, "/api/dashboard", {
    cookie,
    actor: "customer-demo",
  });
  assert.equal(personal.body.orders.length, 3);
  assert.ok(
    personal.body.orders.every((o: any) => o.customerId === "customer-1"),
  );
  assert.equal(personal.body.orders[0].quote.costRate, undefined);
  assert.equal(personal.body.attempts, undefined);
  const company = await call(worker, "/api/dashboard", {
    cookie,
    actor: "company-demo",
  });
  assert.equal(company.body.orders.length, 0);
  const partner = await call(worker, "/api/dashboard", {
    cookie,
    actor: "partner-demo",
  });
  assert.equal(partner.body.orders, undefined);
  assert.ok(partner.body.commissions[0].customerAlias.startsWith("客户-"));
  for (const actor of ["fake-admin", "__proto__", "constructor", ""]) {
    assert.equal(
      (await call(worker, "/api/dashboard", { cookie, actor })).response.status,
      401,
    );
  }
  const denied = await call(worker, "/api/demo/scenario", {
    cookie,
    actor: "customer-demo",
    body: { idempotencyKey: "denied" },
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error, "FORBIDDEN");
  const depositDenied = await call(
    worker,
    `/api/demo/orders/${personal.body.orders[0].id}/deposit`,
    { cookie, actor: "checker-demo", body: {} },
  );
  assert.equal(depositDenied.response.status, 403);
});

test("mutations require same-origin Origin and reject cross-site metadata", async () => {
  const worker = createPreviewWorker();
  const { cookie } = await bootstrap(worker);
  for (const headers of [
    { origin: "https://attacker.example" },
    { origin: "null" },
    { origin: "" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ] as Record<string, string>[]) {
    const denied = await call(worker, "/api/demo/scenario", {
      cookie,
      body: { idempotencyKey: "csrf" },
      headers,
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body.error, "ORIGIN_REJECTED");
  }
  assert.equal(
    (await call(worker, "/api/dashboard", { cookie })).body.orders.length,
    0,
  );
});

test("write calls cannot silently create a session and malformed cookies are rejected", async () => {
  const worker = createPreviewWorker();
  for (const cookie of [
    undefined,
    "__Host-offramp-preview=attacker",
    "__Host-offramp-preview=" + "a".repeat(64),
  ]) {
    const response = await call(worker, "/api/demo/scenario", {
      cookie,
      body: { idempotencyKey: "missing" },
    });
    assert.equal(response.response.status, 410);
    assert.equal(response.body.error, "SESSION_EXPIRED");
    assert.equal(response.response.headers.get("set-cookie"), null);
  }
});

test("duplicate and concurrent seed commands reuse the exact logical scenario", async () => {
  const worker = createPreviewWorker();
  const { cookie } = await bootstrap(worker);
  const results = await Promise.all([
    seed(worker, cookie),
    seed(worker, cookie),
    seed(worker, cookie),
  ]);
  for (const result of results) assert.equal(result.response.status, 200);
  assert.deepEqual(results[0].body.orderIds, results[1].body.orderIds);
  assert.deepEqual(results[0].body.orderIds, results[2].body.orderIds);
  const dashboard = await call(worker, "/api/dashboard", { cookie });
  assert.equal(dashboard.body.orders.length, 3);
  assert.equal(
    dashboard.body.orders.filter((o: any) => o.reconciled).length,
    1,
  );
  const audit = await call(worker, "/api/audit", {
    cookie,
    actor: "auditor-demo",
  });
  assert.equal(
    audit.body.filter((a: any) => a.action === "demo.scenario.created").length,
    1,
  );
  assert.ok(!JSON.stringify(dashboard.body).includes('"secret"'));
});

test("unknown payout remains blocked until independent finance verification", async () => {
  const worker = createPreviewWorker();
  const { cookie } = await bootstrap(worker);
  await seed(worker, cookie);
  const data = (await call(worker, "/api/dashboard", { cookie })).body;
  const attempt = data.attempts.find((a: any) => a.state === "approved");
  assert.ok(attempt);
  const unknown = await call(worker, `/api/attempts/${attempt.id}/record`, {
    cookie,
    body: {
      outcome: "unknown",
      evidence: "MOCK portal timed out, no real payment",
    },
  });
  assert.equal(unknown.response.status, 200);
  const retry = await call(worker, `/api/orders/${attempt.orderId}/attempts`, {
    cookie,
    body: { idempotencyKey: "retry-unknown" },
  });
  assert.equal(retry.response.status, 409);
  assert.equal(retry.body.error, "PAYOUT_LOCKED");
  assert.equal(
    (
      await call(worker, `/api/attempts/${attempt.id}/resolve`, {
        cookie,
        body: {
          outcome: "failed",
          evidence: "MOCK independently verified no payment",
        },
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await call(worker, `/api/attempts/${attempt.id}/resolve`, {
        cookie,
        actor: "checker-demo",
        body: {
          outcome: "failed",
          evidence: "MOCK independently verified no payment",
        },
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await call(worker, `/api/orders/${attempt.orderId}/attempts`, {
        cookie,
        body: { idempotencyKey: "retry-verified" },
      })
    ).response.status,
    200,
  );
});

test("session expires at a fixed 30 minutes and dashboard restarts with empty fixture state", async () => {
  let now = Date.parse("2026-10-13T08:00:00Z");
  const worker = createPreviewWorker({ now: () => now });
  const { cookie } = await bootstrap(worker);
  await seed(worker, cookie);
  now += PREVIEW_LIMITS.ttlMs;
  const expired = await seed(worker, cookie);
  assert.equal(expired.response.status, 410);
  assert.equal(expired.body.error, "SESSION_EXPIRED");
  const fresh = await call(worker, "/api/dashboard", { cookie });
  assert.equal(fresh.body.orders.length, 0);
  assert.notEqual(
    fresh.response.headers.get("set-cookie")?.split(";", 1)[0],
    cookie,
  );
});

test("session cap evicts only old synthetic state and preserves other sessions", async () => {
  let now = Date.parse("2026-10-13T08:00:00Z");
  const worker = createPreviewWorker({ now: () => now });
  const cookies: string[] = [];
  for (let i = 0; i <= PREVIEW_LIMITS.maxSessions; i++) {
    cookies.push((await bootstrap(worker)).cookie);
    now++;
  }
  assert.equal((await seed(worker, cookies[0])).body.error, "SESSION_EXPIRED");
  assert.equal((await seed(worker, cookies[1])).response.status, 200);
  assert.equal(
    (await call(worker, "/api/dashboard", { cookie: cookies.at(-1)! })).body
      .orders.length,
    0,
  );
});

test("one MiB storage cap rolls back the oversized core transaction", async () => {
  const store = new BoundedMemoryStore();
  const before = await store.read();
  await assert.rejects(
    store.transaction((s) => {
      s.customers.push({
        id: "huge",
        kind: "personal",
        status: "pending",
        name: "x".repeat(PREVIEW_LIMITS.maxStateBytes),
      });
    }),
    /storage is full/,
  );
  assert.deepEqual(await store.read(), before);
});

test("request and command rates are bounded and reset after a minute", async () => {
  let now = Date.parse("2026-10-13T08:00:00Z");
  const worker = createPreviewWorker({ now: () => now });
  const { cookie } = await bootstrap(worker);
  for (let i = 1; i < PREVIEW_LIMITS.requestsPerMinute; i++)
    assert.equal(
      (await call(worker, "/api/dashboard", { cookie })).response.status,
      200,
    );
  const limited = await call(worker, "/api/dashboard", { cookie });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get("retry-after"), "60");
  now += 60_000;
  for (let i = 0; i < PREVIEW_LIMITS.commandsPerMinute; i++)
    assert.equal(
      (await call(worker, "/api/customers", { cookie, body: {} })).response
        .status,
      400,
    );
  assert.equal((await seed(worker, cookie)).response.status, 429);
});

test("oversized payloads and unregistered API methods never mutate state", async () => {
  const worker = createPreviewWorker();
  const { cookie } = await bootstrap(worker);
  assert.equal(
    (
      await call(worker, "/api/customers", {
        cookie,
        body: {
          kind: "personal",
          name: "x".repeat(PREVIEW_LIMITS.maxBodyBytes),
        },
      })
    ).response.status,
    413,
  );
  for (const path of [
    "/api/webhooks/mock-deposit",
    "/api/receiveDeposit",
    "/api/store/transaction",
    "/api/orders/a/execute-real",
  ]) {
    const result = await call(worker, path, { cookie, body: {} });
    assert.equal(result.response.status, 404);
  }
  assert.equal(
    (await call(worker, "/api/dashboard", { cookie })).body.orders.length,
    0,
  );
});

test("quote input goes unchanged through real fixed-point core calculation", async () => {
  const worker = createPreviewWorker();
  const { cookie } = await bootstrap(worker);
  const quote = await call(worker, "/api/quotes", {
    cookie,
    body: {
      customerId: "customer-1",
      beneficiaryId: "beneficiary-cn",
      sourceCurrency: "USDT",
      sourceAmount: "1000",
      amountMode: "total_deposit",
    },
  });
  assert.equal(quote.response.status, 200);
  assert.equal(quote.body.sourceAmount, "993.000000");
  assert.equal(quote.body.totalDeposit, "1000.000000");
  assert.equal(quote.body.payoutAmount, "7149.60");
});

test("non-API requests are delegated to the ASSETS binding", async () => {
  const response = await createPreviewWorker().fetch(
    new Request(origin + "/_next/static/app.js"),
    env,
  );
  assert.equal(await response.text(), "asset:/_next/static/app.js");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("explicit reset discards only current synthetic session and cannot extend its expiry", async () => {
  let now = Date.parse("2026-10-13T08:00:00Z");
  const worker = createPreviewWorker({ now: () => now });
  const a = await bootstrap(worker);
  const b = await bootstrap(worker);
  await seed(worker, a.cookie);
  await seed(worker, b.cookie);
  assert.equal(
    (await call(worker, "/api/demo/reset", { cookie: a.cookie, body: {} }))
      .response.status,
    400,
  );
  assert.equal(
    (
      await call(worker, "/api/demo/reset", {
        cookie: a.cookie,
        actor: "customer-demo",
        body: { confirm: "reset-synthetic-session" },
      })
    ).response.status,
    403,
  );
  now += PREVIEW_LIMITS.ttlMs - 1;
  const reset = await call(worker, "/api/demo/reset", {
    cookie: a.cookie,
    body: { confirm: "reset-synthetic-session" },
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.body.scope, "current-session");
  assert.equal(
    (await call(worker, "/api/dashboard", { cookie: a.cookie })).body.orders
      .length,
    0,
  );
  assert.equal(
    (await call(worker, "/api/dashboard", { cookie: b.cookie })).body.orders
      .length,
    3,
  );
  now++;
  assert.equal((await seed(worker, a.cookie)).body.error, "SESSION_EXPIRED");
});

test("pending queue is bounded and active synthetic sessions cannot be capacity-evicted", async () => {
  let now = Date.parse("2026-10-13T08:00:00Z");
  const worker = createPreviewWorker({ now: () => now });
  const first = await bootstrap(worker);
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const pending: Promise<Response>[] = [];
  for (let i = 0; i < PREVIEW_LIMITS.maxPendingPerSession; i++) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streams.push(controller);
      },
    });
    pending.push(
      worker.fetch(
        new Request(origin + "/api/demo/scenario", {
          method: "POST",
          headers: {
            origin,
            cookie: first.cookie,
            "x-demo-actor": "maker-demo",
            "content-type": "application/json",
          },
          body,
          duplex: "half",
        } as RequestInit),
        env,
      ),
    );
  }
  // Each fetch reserves its queue slot synchronously before waiting for the body.
  const denied = await seed(worker, first.cookie);
  assert.equal(denied.response.status, 429);
  assert.equal(denied.body.error, "SESSION_BUSY");
  for (let i = 0; i < PREVIEW_LIMITS.maxSessions; i++) {
    now++;
    await bootstrap(worker);
  }
  for (const stream of streams) {
    stream.enqueue(
      new TextEncoder().encode(JSON.stringify({ idempotencyKey: "pending" })),
    );
    stream.close();
  }
  for (const response of await Promise.all(pending))
    assert.equal(response.status, 200);
  assert.equal(
    (await call(worker, "/api/dashboard", { cookie: first.cookie })).body.orders
      .length,
    3,
  );
});

test("validation and unexpected errors never expose request data or implementation stacks", async () => {
  const worker = createPreviewWorker();
  const { cookie } = await bootstrap(worker);
  const invalid = await call(worker, "/api/quotes", {
    cookie,
    body: { secret: "must-not-be-reflected", invalid: true },
  });
  assert.equal(invalid.response.status, 400);
  assert.ok(!JSON.stringify(invalid.body).includes("must-not-be-reflected"));
  const response = await worker.fetch(new Request(origin + "/broken-asset"), {
    ASSETS: {
      fetch: async () => {
        throw new Error("provider-secret-and-stack");
      },
    },
  });
  assert.equal(response.status, 500);
  const errorBody = (await response.json()) as {
    error: string;
    message: string;
  };
  assert.equal(errorBody.error, "INTERNAL_ERROR");
  assert.ok(!JSON.stringify(errorBody).includes("provider-secret-and-stack"));
});

test("merchant admin completes target quote, payment and scoped demo receipt without role switches", async () => {
  const worker = createPreviewWorker();
  const { cookie } = await bootstrap(worker, "admin-demo");
  const common = { cookie, actor: "admin-demo" };
  const q = await call(worker, "/api/quotes", {
    ...common,
    body: {
      customerId: "customer-1",
      beneficiaryId: "beneficiary-cn",
      sourceCurrency: "USDT",
      amountMode: "target_payout",
      targetAmount: "100000",
      payoutCurrency: "CNY",
    },
  });
  assert.equal(q.response.status, 200);
  assert.equal(q.body.totalDeposit, "13895.888889");
  const created = await call(worker, "/api/orders", {
    ...common,
    body: { quoteId: q.body.id, clientOrderId: "merchant-order" },
  });
  const o = created.body;
  assert.equal(o.fundingInstruction.payable, false);
  assert.equal(o.fundingInstruction.address, null);
  assert.equal(
    (
      await call(worker, `/api/demo/orders/${o.id}/deposit`, {
        ...common,
        body: {},
      })
    ).response.status,
    200,
  );
  const paid = await call(worker, `/api/orders/${o.id}/manual-payout`, {
    ...common,
    body: {
      idempotencyKey: "merchant-paid",
      outcome: "sent",
      actualAmount: "100000",
      paidAt: new Date().toISOString(),
      providerReference: "merchant-payment-ref",
      evidence: "Synthetic administrator attestation",
    },
  });
  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.payoutStatus, "sent");
  assert.equal(paid.body.receiptFileAvailable, false);
  const file = {
    fileName: "demo.pdf",
    contentType: "application/pdf",
    dataBase64: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"),
  };
  const upload = await call(worker, `/api/orders/${o.id}/receipt-file`, {
    ...common,
    body: file,
  });
  assert.equal(upload.response.status, 200);
  assert.equal(upload.body.receiptFileAvailable, true);
  const download = await call(worker, `/api/orders/${o.id}/receipt-file`, {
    cookie,
    actor: "customer-demo",
  });
  assert.equal(download.response.status, 200);
  assert.equal(download.body.dataBase64, file.dataBase64);
  assert.equal(
    (
      await call(worker, `/api/orders/${o.id}/receipt-file`, {
        cookie,
        actor: "company-demo",
      })
    ).response.status,
    403,
  );
  const other = await bootstrap(worker, "admin-demo");
  assert.equal(
    (
      await call(worker, `/api/orders/${o.id}/receipt-file`, {
        cookie: other.cookie,
        actor: "admin-demo",
      })
    ).response.status,
    404,
  );
});

test("two MiB demo receipt works within bounded session and larger file is rejected", async () => {
  const worker = createPreviewWorker();
  const { cookie } = await bootstrap(worker, "admin-demo");
  const common = { cookie, actor: "admin-demo" };
  await call(worker, "/api/demo/scenario", {
    ...common,
    body: { idempotencyKey: "large-receipt" },
  });
  const dashboard = await call(worker, "/api/dashboard", common);
  const o = dashboard.body.orders.find((x: any) => x.payoutStatus === "sent");
  const bytes = Buffer.alloc(2 * 1024 * 1024, 32);
  bytes.write("%PDF-1.4\n");
  const file = {
    fileName: "large-demo.pdf",
    contentType: "application/pdf",
    dataBase64: bytes.toString("base64"),
  };
  const result = await call(worker, `/api/orders/${o.id}/receipt-file`, {
    ...common,
    body: file,
  });
  assert.equal(result.response.status, 200);
  const download = await call(worker, `/api/orders/${o.id}/receipt-file`, {
    cookie,
    actor: "customer-demo",
  });
  assert.equal(download.body.size, 2 * 1024 * 1024);
  const denied = await call(worker, `/api/orders/${o.id}/receipt-file`, {
    ...common,
    body: {
      ...file,
      dataBase64: Buffer.concat([bytes, Buffer.from("x")]).toString("base64"),
    },
  });
  assert.equal(denied.response.status, 409);
});
