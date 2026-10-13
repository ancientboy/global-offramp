import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NestFactory } from "@nestjs/core";
import { makeAppModule } from "../src/app";
import { MemoryStore } from "../../../packages/core/src/store";
import { UnconfiguredIdentityProvider } from "../../../packages/core/src/adapters";
test("unconfigured real identity provider always refuses verification", async () => {
  await assert.rejects(
    () => new UnconfiguredIdentityProvider().verifyAccessToken(),
    /PRODUCTION_AUTH_REQUIRED/,
  );
});
test("integrated demo scenarios create linked server state idempotently with scoped views", async () => {
  process.env.EXECUTION_MODE = "mock";
  process.env.DEMO_AUTH = "true";
  process.env.NODE_ENV = "test";
  process.env.WEBHOOK_SECRET = "http-test-secret-with-32-characters";
  const store = new MemoryStore();
  const app = await NestFactory.create(makeAppModule(store), {
    rawBody: true,
    logger: false,
  });
  try {
    await app.listen(0, "127.0.0.1");
    const url = await app.getUrl();
    const post = (path: string, body: unknown, actor: string) =>
      fetch(url + "/api/" + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-demo-actor": actor },
        body: JSON.stringify(body),
      });
    const dashboard = async (actor: string) => {
      const res = await fetch(url + "/api/dashboard", {
        headers: { "x-demo-actor": actor },
      });
      assert.equal(res.status, 200);
      return res.json() as Promise<any>;
    };
    assert.equal(
      (
        await post(
          "demo/scenario",
          { idempotencyKey: "connected-demo" },
          "customer-demo",
        )
      ).status,
      403,
    );
    const [a, b] = await Promise.all([
      post("demo/scenario", { idempotencyKey: "connected-demo" }, "maker-demo"),
      post("demo/scenario", { idempotencyKey: "connected-demo" }, "maker-demo"),
    ]);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.deepEqual(await a.json(), await b.json());
    assert.equal((await store.read()).orders.length, 3);
    const admin = await dashboard("checker-demo");
    assert.equal(
      admin.orders.filter((o: any) => o.payoutStatus === "approved").length,
      1,
    );
    assert.equal(admin.orders.filter((o: any) => o.reconciled).length, 1);
    assert.ok(admin.pricingFixture);
    assert.equal(admin.commissions.length, 1);
    assert.equal(admin.commissions[0].eligibility, "hold");
    const customer = await dashboard("customer-demo");
    assert.equal(customer.orders.length, 3);
    assert.equal(customer.pricingFixture, undefined);
    assert.equal(customer.orders[0].quote.costRate, undefined);
    assert.equal(customer.commissions, undefined);
    const company = await dashboard("company-demo");
    assert.equal(company.orders.length, 0);
    assert.ok(
      company.beneficiaries.every((b: any) => b.customerId === "customer-2"),
    );
    const partner = await dashboard("partner-demo");
    assert.equal(partner.orders, undefined);
    assert.equal(partner.commissions.length, 1);
    assert.equal(partner.commissions[0].value, "1.000000");
    assert.equal(partner.commissions[0].eligibility, "hold");
    assert.ok(!JSON.stringify(partner).includes("sourceAmount"));
    const q = (await (
      await post(
        "quotes",
        {
          customerId: "customer-1",
          beneficiaryId: "beneficiary-cn",
          sourceCurrency: "USDT",
          sourceAmount: "100",
        },
        "customer-demo",
      )
    ).json()) as any;
    const o = (await (
      await post(
        "orders",
        { quoteId: q.id, clientOrderId: "connected-user-order" },
        "customer-demo",
      )
    ).json()) as any;
    assert.equal(
      (await post(`demo/orders/${o.id}/deposit`, {}, "customer-demo")).status,
      403,
    );
    assert.equal(
      (await post(`demo/orders/${o.id}/deposit`, {}, "maker-demo")).status,
      201,
    );
    assert.equal(
      (await store.read()).orders.find((x) => x.id === o.id)?.depositStatus,
      "confirmed",
    );
    const before = await store.read();
    await post(
      "demo/scenario",
      { idempotencyKey: "connected-demo" },
      "maker-demo",
    );
    assert.deepEqual(await store.read(), before);
  } finally {
    await app.close();
  }
});
