import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NestFactory } from "@nestjs/core";
import { makeAppModule } from "../src/app";
import { MemoryStore } from "../../../packages/core/src/store";
import { signWebhook } from "../../../packages/core/src/security";
test("NestJS HTTP mock flow authenticates scope and accepts only signed deposits", async () => {
  process.env.EXECUTION_MODE = "mock";
  process.env.DEMO_AUTH = "true";
  process.env.NODE_ENV = "test";
  process.env.WEBHOOK_SECRET = "http-test-secret-with-32-characters";
  const app = await NestFactory.create(makeAppModule(new MemoryStore()), {
    rawBody: true,
    logger: false,
  });
  try {
    await app.listen(0, "127.0.0.1");
    const url = await app.getUrl();
    async function post(path: string, body: unknown, actor = "customer-demo") {
      return fetch(url + "/api/" + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-demo-actor": actor },
        body: JSON.stringify(body),
      });
    }
    assert.equal((await fetch(url + "/api/health")).status, 200);
    assert.equal((await fetch(url + "/api/dashboard")).status, 401);
    assert.equal(
      (
        await post("quotes", {
          customerId: "customer-2",
          beneficiaryId: "beneficiary-company",
          sourceCurrency: "USDT",
          sourceAmount: "100",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await post("quotes", {
          customerId: "customer-1",
          beneficiaryId: "beneficiary-cn",
          sourceCurrency: "USDT",
          sourceAmount: 100,
        })
      ).status,
      400,
    );
    const quote = (await (
      await post("quotes", {
        customerId: "customer-1",
        beneficiaryId: "beneficiary-cn",
        sourceCurrency: "USDT",
        sourceAmount: "100",
      })
    ).json()) as any;
    assert.equal(quote.costRate, undefined);
    const order = (await (
      await post("orders", { quoteId: quote.id, clientOrderId: "http-demo" })
    ).json()) as any;
    const raw = Buffer.from(
      JSON.stringify({
        eventId: "http-event",
        transactionId: "http-tx",
        orderId: order.id,
        currency: "USDT",
        amount: "107",
        network: "MOCK",
        confirmations: 1,
      }),
    );
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const deposited = await fetch(url + "/api/webhooks/mock-deposit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": signWebhook(
          raw,
          timestamp,
          process.env.WEBHOOK_SECRET!,
        ),
      },
      body: raw,
    });
    assert.equal(deposited.status, 201);
    assert.equal(((await deposited.json()) as any).depositStatus, "confirmed");
  } finally {
    await app.close();
  }
});

test("Nest wallet routes support scoped credits, cancellation and quoted batch funding", async () => {
  process.env.EXECUTION_MODE = "mock";
  process.env.DEMO_AUTH = "true";
  process.env.NODE_ENV = "test";
  const app = await NestFactory.create(makeAppModule(new MemoryStore()), {
    rawBody: true,
    logger: false,
  });
  try {
    await app.listen(0, "127.0.0.1");
    const url = await app.getUrl();
    async function post(path: string, body: unknown, actor = "customer-demo") {
      const response = await fetch(url + "/api/" + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-demo-actor": actor },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as any };
    }
    const deposit = {
      customerId: "customer-1",
      currency: "USDT",
      amount: "1000",
      idempotencyKey: "wallet",
    };
    assert.equal((await post("wallet/deposits", deposit)).status, 201);
    assert.equal((await post("wallet/deposits", deposit)).body.duplicate, true);
    assert.equal(
      (await post("wallet/deposits", deposit, "company-demo")).status,
      403,
    );
    const q = await post("quotes", {
      customerId: "customer-1",
      beneficiaryId: "beneficiary-cn",
      sourceCurrency: "USDT",
      sourceAmount: "100",
    });
    const o = await post("orders", {
      quoteId: q.body.id,
      clientOrderId: "order",
      fundingSource: "wallet",
    });
    assert.equal(
      (await post(`orders/${o.body.id}/cancel`, { reason: "cancel mock test" }))
        .body.walletFundingStatus,
      "released",
    );
    const b = await post("batches", {
      customerId: "customer-1",
      clientBatchId: "batch",
      csv: "clientItemId,beneficiaryId,sourceCurrency,sourceAmount\na,beneficiary-cn,USDT,100",
    });
    const preview = await post(`batches/${b.body.batch.id}/quote`, {});
    assert.equal(preview.status, 201);
    assert.equal(preview.body.totals[0].totalDeposit, "107.000000");
    const missing = await post(`batches/${b.body.batch.id}/submit`, {
      fundingSource: "wallet",
    });
    assert.equal(missing.body.error, "BATCH_QUOTE_REQUIRED");
    const submitted = await post(`batches/${b.body.batch.id}/submit`, {
      fundingSource: "wallet",
      quoteIds: preview.body.quotes.map((q: any) => q.id),
    });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.items[0].status, "created");
  } finally {
    await app.close();
  }
});
