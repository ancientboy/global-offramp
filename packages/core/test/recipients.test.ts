import assert from "node:assert/strict";
import test from "node:test";
import { ACTORS } from "../src/fixtures";
import { harness } from "./helpers";

const details = {
  name: "Synthetic recipient",
  country: "CN",
  currency: "CNY",
  accountToken: "mock-last-four",
  accountMasked: "**** 1234",
};
const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (e: any) => e.code === code);

for (const actorKey of ["customer-demo", "company-demo"]) {
  test(`${actorKey}: saved recipient supports wallet single and bulk without approval`, async () => {
    const h = harness();
    const actor = ACTORS[actorKey];
    const customerId = actor.customerId!;
    const b = await h.service.createBeneficiary(actor, {
      ...details,
      customerId,
    });
    assert.equal(b.status, "saved");
    await h.service.depositWallet(actor, {
      customerId,
      currency: "USDT",
      amount: "1000",
      idempotencyKey: "credit",
    });
    const q = await h.service.createQuote(actor, {
      customerId,
      beneficiaryId: b.id,
      sourceCurrency: "USDT",
      sourceAmount: "100",
    });
    await h.service.createOrder(actor, {
      quoteId: q.id,
      clientOrderId: "single",
      fundingSource: "wallet",
    });
    assert.equal((await h.store.read()).orders[0].quote.beneficiaryId, b.id);
    const batch = await h.service.importBatch(
      actor,
      customerId,
      "bulk",
      `clientItemId,beneficiaryId,sourceCurrency,sourceAmount\na,${b.id},USDT,100\nb,${b.id},USDT,100`,
    );
    assert.ok(batch.items.every((i) => i.status === "valid"));
    const preview = await h.service.quoteBatch(actor, batch.batch.id);
    await h.service.submitBatch(actor, batch.batch.id, {
      fundingSource: "wallet",
      quoteIds: preview.quotes.map((q) => q.id),
    });
    const state = await h.store.read();
    assert.equal(state.orders.length, 3);
    assert.equal(state.beneficiaries.at(-1)?.status, "saved");
    assert.equal(
      state.audits.some((a) => a.action === "beneficiary.approved"),
      false,
    );
  });
}

test("legacy pending and approved recipients remain usable, unknown and suspended statuses do not", async () => {
  const h = harness();
  const actor = ACTORS["customer-demo"];
  for (const status of [
    "pending",
    "approved",
    "suspended",
    "unexpected",
  ] as const) {
    await h.store.transaction((s) => {
      s.beneficiaries[0].status = status as any;
    });
    const quote = h.service.createQuote(actor, {
      customerId: "customer-1",
      beneficiaryId: "beneficiary-cn",
      sourceCurrency: "USDT",
      sourceAmount: "100",
    });
    const batch = await h.service.importBatch(
      actor,
      "customer-1",
      status,
      `clientItemId,beneficiaryId,sourceCurrency,sourceAmount\n${status},beneficiary-cn,USDT,100`,
    );
    if (status === "pending" || status === "approved") {
      assert.equal((await quote).beneficiaryId, "beneficiary-cn");
      assert.equal(batch.items[0].status, "valid");
      assert.equal(
        (await h.service.quoteBatch(actor, batch.batch.id)).quotes.length,
        1,
      );
    } else {
      await rejects(quote, "BENEFICIARY_BLOCKED");
      assert.equal(batch.items[0].status, "error");
    }
  }
});

test("saved recipient keeps customer ownership, suspension, field and route guards", async () => {
  const h = harness();
  const actor = ACTORS["customer-demo"];
  const input = { ...details, customerId: "customer-1" };
  for (const patch of [
    { name: "" },
    { accountToken: "" },
    { accountMasked: "1234567890" },
    { country: "invalid" },
    { currency: "JPY" },
  ]) {
    await assert.rejects(
      h.service.createBeneficiary(actor, { ...input, ...patch }),
      (e: any) => e.name === "ZodError",
    );
  }
  await rejects(
    h.service.createBeneficiary(actor, { ...input, country: "US" }),
    "ROUTE_MISMATCH",
  );
  await rejects(
    h.service.createBeneficiary(actor, { ...input, customerId: "customer-2" }),
    "FORBIDDEN",
  );
  await rejects(
    h.service.createBeneficiary(actor, { ...input, country: "GB" }),
    "ROUTE_MISMATCH",
  );
  await rejects(
    h.service.createBeneficiary(actor, { ...input, currency: "EUR" }),
    "ROUTE_MISMATCH",
  );
  const b = await h.service.createBeneficiary(actor, input);
  const quoteInput = {
    customerId: "customer-1",
    beneficiaryId: b.id,
    sourceCurrency: "USDT",
    sourceAmount: "100",
  };
  await rejects(
    h.service.createQuote(ACTORS["company-demo"], {
      ...quoteInput,
      customerId: "customer-2",
    }),
    "BENEFICIARY_BLOCKED",
  );
  const foreign = await h.service.importBatch(
    ACTORS["company-demo"],
    "customer-2",
    "foreign",
    `clientItemId,beneficiaryId,sourceCurrency,sourceAmount\nforeign,${b.id},USDT,100`,
  );
  assert.equal(foreign.items[0].status, "error");
  await rejects(
    h.service.createQuote(actor, { ...quoteInput, payoutCurrency: "USD" }),
    "CURRENCY_MISMATCH",
  );
  await h.store.transaction((s) => {
    s.customers[0].status = "suspended";
  });
  await rejects(h.service.createBeneficiary(actor, input), "CUSTOMER_BLOCKED");
  await rejects(h.service.createQuote(actor, quoteInput), "CUSTOMER_BLOCKED");
});

test("recipient names accept short Chinese names, trim whitespace and reject blank or overlong values", async () => {
  const h = harness();
  const actor = ACTORS["customer-demo"];
  const input = { ...details, customerId: "customer-1" };
  const b = await h.service.createBeneficiary(actor, {
    ...input,
    name: "  虚构  ",
  });
  assert.equal(b.name, "虚构");
  assert.equal(b.status, "saved");
  for (const name of ["", "   ", "\t\n", "虚".repeat(101)]) {
    await assert.rejects(
      h.service.createBeneficiary(actor, { ...input, name }),
      (e: any) => e.name === "ZodError",
    );
  }
  assert.equal((await h.store.read()).beneficiaries.length, 4);
});
