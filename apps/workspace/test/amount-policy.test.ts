import test from "node:test";
import assert from "node:assert/strict";
import { moneyFixture, refundInput } from "./helpers/money";
test("unlimited defaults accept large settled deposits and repeated withdrawals beyond former daily caps while enforcing available balance", async () => {
  const f = await moneyFixture();
  try {
    assert.equal(f.funding.publicConfig().maxDeposit, null);
    assert.equal(f.money.maxAmount, null);
    assert.equal(f.money.dailyLimit, null);
    const p = await f.funding.create(f.user, {
      currency: "USDC",
      network: "usdcbase",
      amount: "20000000",
      idempotencyKey: "unlimited-large-deposit",
    });
    Object.assign(f.payments.get("102"), {
      payment_status: "finished",
      outcome_amount: 20000000,
    });
    await f.funding.refresh({ id: p.id, provider_id: "102" });
    assert.equal(await f.balance(), "20000100.000000");
    const first = await f.money.create(f.user, "refund", {
      ...refundInput,
      amount: "10000000",
      idempotencyKey: "unlimited-withdrawal-one",
    });
    const second = await f.money.create(f.user, "refund", {
      ...refundInput,
      amount: "6000",
      idempotencyKey: "unlimited-withdrawal-two",
    });
    assert.equal(first.amount, "10000000.000000");
    assert.equal(second.amount, "6000.000000");
    assert.equal(await f.balance(), "9994100.000000");
    const retry = await f.money.create(f.user, "refund", {
      ...refundInput,
      amount: "6000",
      idempotencyKey: "unlimited-withdrawal-two",
    });
    assert.equal(retry.id, second.id);
    assert.equal(await f.balance(), "9994100.000000");
    await assert.rejects(
      () =>
        f.money.create(f.user, "refund", {
          ...refundInput,
          amount: "9994101",
          idempotencyKey: "unlimited-still-no-overdraft",
        }),
      (e) => (e as any).code === "INSUFFICIENT_BALANCE",
    );
    await assert.rejects(
      () =>
        f.money.create(f.user, "refund", {
          ...refundInput,
          amount: "0",
          idempotencyKey: "unlimited-zero-refund",
        }),
      (e) => (e as any).code === "INVALID_AMOUNT",
    );
    await assert.rejects(
      () =>
        f.funding.create(f.user, {
          currency: "USDC",
          network: "usdcbase",
          amount: "0",
          idempotencyKey: "unlimited-zero-deposit",
        }),
      (e) => (e as any).code === "INVALID_AMOUNT",
    );
    assert.equal(await f.balance(), "9994100.000000");
    const overpaid = await f.funding.create(f.user, {
      currency: "USDC",
      network: "usdcbase",
      amount: "10",
      idempotencyKey: "unlimited-overpaid-net",
    });
    Object.assign(f.payments.get("103"), {
      payment_status: "finished",
      outcome_amount: 6000,
    });
    await f.funding.refresh({ id: overpaid.id, provider_id: "103" });
    assert.equal(await f.balance(), "10000100.000000");
  } finally {
    await f.db.close();
  }
});
