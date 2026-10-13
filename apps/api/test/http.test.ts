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
