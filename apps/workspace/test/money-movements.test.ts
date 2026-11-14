import test from "node:test";
import assert from "node:assert/strict";
import {
  address,
  ChainTransfers,
  TRON_USDT,
  BASE_USDC,
} from "../src/chain-transfers";
import {
  moneyFixture,
  chainHarness,
  event,
  refundInput,
  SOURCE,
  DEST,
  TX,
  TRX,
  TSOURCE,
  TDEST,
  PASSWORD,
} from "./helpers/money";
import { financialReport, reportCsv } from "../src/financial-report";
import { totp } from "../src/totp";
const failure = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: any) => e.code === code);
test("wallet addresses enforce Base checksum and Tron Base58Check; invalid/burn addresses fail", () => {
  assert.equal(
    address("usdcbase", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    BASE_USDC,
  );
  assert.equal(address("usdttrc20", TRON_USDT), TRON_USDT);
  for (const [network, a] of [
    ["usdcbase", "0x0000000000000000000000000000000000000000"],
    ["usdcbase", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02912"],
    ["usdttrc20", TDEST.slice(0, -1) + "0"],
    ["usdttrc20", "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb"],
  ] as const)
    assert.throws(() => address(network, a));
});
test("Base outgoing verification requires mainnet, finalized canonical success and exact token/from/to/amount", async () => {
  const h = chainHarness(),
    expectation = {
      network: "usdcbase" as const,
      destination: DEST,
      amount: "5.000000",
      approvedAt: new Date(),
    };
  assert.equal((await h.chain.verify(expectation, { txid: TX })).logIndex, 7);
  h.state.finalized = "0xff";
  await failure(
    h.chain.verify(expectation, { txid: TX }),
    "TRANSACTION_NOT_FINAL",
  );
  h.state.finalized = "0x200";
  h.state.receipt.status = "0x0";
  await failure(
    h.chain.verify(expectation, { txid: TX }),
    "TRANSACTION_FAILED",
  );
  h.state.receipt.status = "0x1";
  for (const [field, value] of [
    ["address", SOURCE],
    ["data", event("6").data],
    ["removed", true],
    ["transactionHash", "0x" + "ff".repeat(32)],
  ] as const) {
    const old = h.state.receipt.logs[0][field];
    h.state.receipt.logs[0][field] = value;
    await failure(
      h.chain.verify(expectation, { txid: TX }),
      "TRANSFER_MISMATCH",
    );
    h.state.receipt.logs[0][field] = old;
  }
  h.state.blockHash = "0x" + "ff".repeat(32);
  await failure(
    h.chain.verify(expectation, { txid: TX }),
    "TRANSACTION_NOT_FINAL",
  );
  delete h.state.blockHash;
  h.state.chainId = "0x1";
  await failure(
    h.chain.verify(expectation, { txid: TX }),
    "CHAIN_NETWORK_MISMATCH",
  );
  h.state.chainId = "0x2105";
  h.state.receipt.logs.push(event("5", "usdcbase", 8));
  await failure(
    h.chain.verify(expectation, { txid: TX }),
    "AMBIGUOUS_TRANSFER",
  );
  assert.equal(
    (await h.chain.verify(expectation, { txid: TX, logIndex: 8 })).logIndex,
    8,
  );
  await failure(
    new ChainTransfers().verify(expectation, { txid: TX }),
    "TREASURY_WALLET_UNCONFIGURED",
  );
  h.state.failed = true;
  await failure(
    h.chain.verify(expectation, { txid: TX }),
    "CHAIN_LOOKUP_UNAVAILABLE",
  );
});
test("Tron verifier uses solidified receipt, transaction success, canonical block and matching USDT event", async () => {
  const h = chainHarness(),
    e = {
      network: "usdttrc20" as const,
      destination: TDEST,
      amount: "5",
      approvedAt: new Date(),
    };
  const proof = await h.chain.verify(e, { txid: TRX });
  assert.equal(proof.logIndex, 0);
  assert.equal(proof.blockHash, "de".repeat(32));
  assert.equal(proof.sourceAddress, TSOURCE);
  h.state.tronInfo.receipt.result = "REVERT";
  await failure(h.chain.verify(e, { txid: TRX }), "TRANSACTION_FAILED");
  h.state.tronInfo.receipt.result = "SUCCESS";
  h.state.tronInfo.log[0].data = event("6", "usdttrc20").data;
  await failure(h.chain.verify(e, { txid: TRX }), "TRANSFER_MISMATCH");
});
test("refund creates a single reservation, enforces scope and releases only unapproved requests", async () => {
  const f = await moneyFixture();
  try {
    const r = await f.money.create(f.user, "refund", refundInput);
    assert.equal(await f.balance(), "95.000000");
    assert.equal(
      (await f.money.create(f.user, "refund", refundInput)).id,
      r.id,
    );
    assert.equal(await f.balance(), "95.000000");
    await failure(
      f.money.create(f.user, "refund", { ...refundInput, amount: "6" }),
      "IDEMPOTENCY_CONFLICT",
    );
    await failure(
      f.money.decide({ ...f.user, customer_id: "other" }, r.id, {
        action: "cancel",
        note: "foreign customer",
      }),
      "NOT_FOUND",
    );
    await failure(
      f.money.decide(f.user, r.id, { action: "approve", note: "self approve" }),
      "FORBIDDEN",
    );
    await f.money.decide(f.user, r.id, {
      action: "cancel",
      note: "取消退款申请",
    });
    await f.money.decide(f.user, r.id, {
      action: "cancel",
      note: "重复取消申请",
    });
    assert.equal(await f.balance(), "100.000000");
    const next = await f.money.create(f.user, "refund", {
      ...refundInput,
      idempotencyKey: "second-refund",
    });
    await f.money.decide(f.admin, next.id, {
      action: "approve",
      note: "已核对申请地址",
    });
    await failure(
      f.money.decide(f.user, next.id, {
        action: "cancel",
        note: "approved cancel",
      }),
      "MOVEMENT_LOCKED",
    );
    assert.equal(await f.balance(), "95.000000");
    await assert.rejects(
      () =>
        f.pool.query(
          "UPDATE workspace.money_movements SET destination=$2 WHERE id=$1",
          [next.id, SOURCE],
        ),
      /immutable/,
    );
    const report = await financialReport(f.auth, f.admin);
    assert.ok(
      report.rows.every(
        (r) => r.ledgerBalanced && r.depositsMatch && r.movementHoldsMatch,
      ),
    );
    assert.equal(
      report.rows.find((r) => r.currency === "USDC")!.pendingMovements,
      "5.000000",
    );
  } finally {
    await f.db.close();
  }
});
test("verified outflow is exact-once, a transfer event cannot satisfy two refund requests, and RPC failure retains holds", async () => {
  const f = await moneyFixture();
  try {
    const one = await f.money.create(f.user, "refund", refundInput),
      two = await f.money.create(f.user, "refund", {
        ...refundInput,
        idempotencyKey: "refund-request-2",
      });
    for (const r of [one, two])
      await f.money.decide(f.admin, r.id, {
        action: "approve",
        note: "已核对收款信息",
      });
    f.chain.state.failed = true;
    await failure(
      f.money.complete(f.admin, one.id, { txid: TX }),
      "CHAIN_LOOKUP_UNAVAILABLE",
    );
    assert.equal((await f.money.list(f.user))[0].status, "approved");
    f.chain.state.failed = false;
    await f.money.complete(f.admin, one.id, { txid: TX });
    await f.money.complete(f.admin, one.id, { txid: TX });
    await failure(
      f.money.complete(f.admin, two.id, { txid: TX }),
      "TRANSFER_ALREADY_CLAIMED",
    );
    assert.equal(
      (await f.pool.query("SELECT * FROM workspace.chain_transfer_claims")).rows
        .length,
      1,
    );
    assert.equal((await f.money.refundsHeld(f.user))[0].amount, "5.000000");
    assert.equal(await f.balance(), "90.000000");
    const report = await financialReport(f.auth, f.admin),
      row = report.rows.find((r) => r.currency === "USDC")!;
    assert.equal(row.verifiedOutflows, "5.000000");
    assert.equal(row.bookTreasury, "95.000000");
    assert.ok(row.movementHoldsMatch);
    assert.ok(reportCsv(report).startsWith("\ufeff"));
    await assert.rejects(
      () => f.pool.query("DELETE FROM workspace.chain_transfer_claims"),
      /append-only|immutable/,
    );
  } finally {
    await f.db.close();
  }
});
test("provider payable becomes available only after confirmed payment and cannot be settled twice", async () => {
  const f = await moneyFixture();
  try {
    const actor = {
        id: f.user.id,
        role: "customer" as const,
        customerId: f.user.customer_id!,
      },
      adminActor = { id: f.admin.id, role: "merchant_admin" as const };
    const q = await f.core.createQuote(actor, {
        customerId: f.user.customer_id,
        beneficiaryId: "money-recipient",
        sourceCurrency: "USDC",
        sourceAmount: "10",
      }),
      o = (await f.core.createOrder(actor, {
        quoteId: q.id,
        clientOrderId: "provider-test-order",
        fundingSource: "wallet",
      })) as any;
    await f.core.confirmManualPayout(adminActor, o.id, {
      outcome: "unknown",
      evidence: "正在核对外部结果",
      idempotencyKey: "provider-unknown",
    });
    let summary = await f.money.adminSummary(f.admin);
    assert.equal(
      summary.payables.find((p) => p.currency === "USDC")!.available,
      "0.000000",
    );
    const attempt = (await f.store.read()).attempts.at(-1)!;
    await f.core.resolvePayout(adminActor, attempt.id, {
      outcome: "failed",
      evidence: "已核实前次未付款",
    });
    await f.core.confirmManualPayout(adminActor, o.id, {
      outcome: "sent",
      evidence: "已核实外部付款登记",
      idempotencyKey: "provider-paid",
      actualAmount: o.quote.payoutAmount,
      paidAt: new Date().toISOString(),
      providerReference: "isolated-ref",
    });
    summary = await f.money.adminSummary(f.admin);
    const payable = summary.payables.find((p) => p.currency === "USDC")!;
    assert.equal(payable.available, "10.000000");
    const r = await f.money.create(f.admin, "provider_settlement", {
      ...refundInput,
      providerId: payable.providerId,
      amount: "6",
      idempotencyKey: "settlement-one",
    });
    assert.equal(
      (await f.money.adminSummary(f.admin)).payables.find(
        (p) => p.currency === "USDC",
      )!.available,
      "4.000000",
    );
    await failure(
      f.money.create(f.admin, "provider_settlement", {
        ...refundInput,
        providerId: payable.providerId,
        amount: "6",
        idempotencyKey: "settlement-two",
      }),
      "INSUFFICIENT_PROVIDER_PAYABLE",
    );
    await f.money.decide(f.admin, r.id, {
      action: "approve",
      note: "已核对服务商账单",
    });
    f.chain.state.receipt.logs = [event("6")];
    await f.money.complete(f.admin, r.id, { txid: TX });
    assert.equal(
      (await f.pool.query("SELECT * FROM workspace.chain_transfer_claims")).rows
        .length,
      1,
    );
  } finally {
    await f.db.close();
  }
});
test("native API protects customer refund creation with MFA and exposes held funds without cross-customer leakage", async () => {
  const f = await moneyFixture();
  try {
    const login = await f.auth.login(
      { identifier: f.user.email, password: PASSWORD },
      "customer-ip",
    );
    const call = (path: string, body?: unknown) =>
      f.app(
        new Request("https://workspace.example/workspace/api/" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin: "https://workspace.example",
            "content-type": "application/json",
            cookie: "__Secure-offramp-workspace=" + login.token,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        "customer-ip",
      );
    assert.equal(
      (await (await call("wallet/refunds", refundInput)).json()).error,
      "MFA_SETUP_REQUIRED",
    );
    await failure(
      f.security.stepUp(f.user, { code: "123456" }, login.token),
      "MFA_SETUP_REQUIRED",
    );
    const setup = await f.security.setup(f.user, { password: PASSWORD });
    await f.security.confirm(
      f.user,
      { code: totp(setup.secret, Math.floor(Date.now() / 30000)) },
      login.token,
    );
    assert.equal((await call("wallet/refunds", refundInput)).status, 201);
    const dashboard = await (await call("dashboard")).json();
    assert.equal(
      dashboard.walletBalances.find((b: any) => b.currency === "USDC").frozen,
      "5.000000",
    );
    assert.equal(dashboard.moneyMovements.length, 1);
    assert.equal((await call("admin/money/report")).status, 403);
    assert.equal(
      (await f.money.list({ ...f.user, customer_id: "other" })).length,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("funding exceptions link only matching official orders and partial settlement acceptance never fabricates the requested amount", async () => {
  const f = await moneyFixture();
  try {
    const p = await f.funding.create(f.user, {
        currency: "USDC",
        network: "usdcbase",
        amount: "10",
        idempotencyKey: "partial-deposit",
      }),
      provider = f.payments.get("102");
    Object.assign(provider, {
      payment_status: "partially_paid",
      outcome_amount: "8.5",
    });
    await f.funding.refresh({ id: p.id, provider_id: "102" });
    assert.equal(await f.balance(), "100.000000");
    await failure(
      f.funding.resolve(f.user, p.id, {
        decision: "accept_partial",
        note: "尝试自行接受",
      }),
      "FORBIDDEN",
    );
    await f.funding.resolve(f.admin, p.id, {
      decision: "accept_partial",
      note: "接受官方已结算净额",
    });
    await f.funding.resolve(f.admin, p.id, {
      decision: "accept_partial",
      note: "重复核对净额",
    });
    assert.equal(await f.balance(), "108.500000");
    const savedCreate = f.provider.create.bind(f.provider);
    f.provider.create = async () => {
      throw Error("timeout");
    };
    await assert.rejects(() =>
      f.funding.create(f.user, {
        currency: "USDC",
        network: "usdcbase",
        amount: "10",
        idempotencyKey: "unknown-create",
      }),
    );
    f.provider.create = savedCreate;
    const unknown = (
      await f.pool.query(
        "SELECT * FROM workspace.funding_payments WHERE status='creation_unknown'",
      )
    ).rows[0];
    f.payments.set("999", {
      payment_id: 999,
      order_id: "wrong-order",
      pay_currency: "usdcbase",
      price_currency: "usdcbase",
      price_amount: 10,
      pay_amount: 10,
      pay_address: "test-address-999",
      payment_status: "finished",
      outcome_currency: "usdcbase",
      outcome_amount: 9,
    });
    await failure(
      f.funding.resolve(f.admin, unknown.id, {
        decision: "link",
        providerId: "999",
        note: "关联服务商记录",
      }),
      "PAYMENT_IDENTITY_MISMATCH",
    );
    f.payments.get("999").order_id = unknown.id;
    await f.funding.resolve(f.admin, unknown.id, {
      decision: "link",
      providerId: "999",
      note: "已核对独立订单编号",
    });
    assert.equal(await f.balance(), "117.500000");
  } finally {
    await f.db.close();
  }
});

test("abandoned creates enter review, and delayed create responses cannot overwrite an operator-linked paid invoice", async () => {
  const f = await moneyFixture();
  let release: () => void = () => {};
  try {
    await f.pool.query(
      "INSERT INTO workspace.funding_payments(id,account_id,customer_id,idempotency_key,currency,pay_currency,requested_amount,created_at) VALUES('HTDEP-stale-probe',$1,$2,'stale-probe','USDC','usdcbase',10,now()-interval '3 minutes')",
      [f.user.id, f.user.customer_id],
    );
    await f.funding.tick();
    assert.equal(
      (
        await f.pool.query(
          "SELECT status FROM workspace.funding_payments WHERE id='HTDEP-stale-probe'",
        )
      ).rows[0].status,
      "creation_unknown",
    );
    let entered!: (id: string) => void;
    const started = new Promise<string>((r) => (entered = r)),
      wait = new Promise<void>((r) => (release = r));
    f.provider.create = async (id, amount, network) => {
      entered(id);
      await wait;
      return {
        payment_id: 998,
        order_id: id,
        pay_currency: network,
        pay_address: "delayed-address",
        pay_amount: amount,
      };
    };
    const creation = f.funding.create(f.user, {
      currency: "USDC",
      network: "usdcbase",
      amount: "10",
      idempotencyKey: "delayed-create",
    });
    const outcome = creation.then(
      () => null,
      (e) => e,
    );
    const id = await started;
    await f.pool.query(
      "UPDATE workspace.funding_payments SET status='creation_unknown' WHERE id=$1",
      [id],
    );
    f.payments.set("999", {
      payment_id: 999,
      order_id: id,
      pay_currency: "usdcbase",
      price_currency: "usdcbase",
      price_amount: 10,
      pay_amount: 10,
      pay_address: "linked-address",
      payment_status: "finished",
      outcome_currency: "usdcbase",
      outcome_amount: 9,
    });
    await f.funding.resolve(f.admin, id, {
      decision: "link",
      providerId: "999",
      note: "核对超时关联记录",
    });
    release();
    assert.equal((await outcome).code, "PAYMENT_ALREADY_LINKED");
    const row = (
      await f.pool.query(
        "SELECT provider_id,status FROM workspace.funding_payments WHERE id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(row.provider_id, "999");
    assert.equal(row.status, "credited");
    assert.equal(await f.balance(), "109.000000");
  } finally {
    release();
    await f.db.close();
  }
});

test("Base RPC fails over transport outages but keeps each verification on one reviewed mainnet node", async () => {
  const h = chainHarness(),
    calls: string[] = [],
    fetcher: typeof fetch = async (url, options) => {
      calls.push(String(url));
      if (String(url).includes("unavailable.example"))
        throw Error("blocked node");
      return h.chain.fetcher("https://mainnet.base.org", options);
    };
  const chain = new ChainTransfers({ usdcbase: [SOURCE] }, fetcher, [
    "https://unavailable.example",
    "https://reviewed.example",
  ]);
  const proof = await chain.verify(
    {
      network: "usdcbase",
      destination: DEST,
      amount: "5",
      approvedAt: new Date(),
    },
    { txid: TX },
  );
  assert.equal(proof.logIndex, 7);
  assert.equal(
    calls.filter((u) => u.includes("unavailable.example")).length,
    1,
  );
  assert.ok(calls.slice(1).every((u) => u === "https://reviewed.example"));
  assert.throws(
    () => new ChainTransfers({}, fetcher, ["http://unreviewed.example"]),
  );
  assert.throws(
    () => new ChainTransfers({}, fetcher, ["https://user:secret@example.com"]),
  );
});

test("optional withdrawal notes retain exact-once holds, rejection reasons and paginated admin scope", async () => {
  const f = await moneyFixture();
  try {
    const input = {
      ...refundInput,
      reason: "",
      idempotencyKey: "optional-note-test",
    };
    const r = await f.money.create(f.user, "refund", input);
    assert.equal((await f.money.create(f.user, "refund", input)).id, r.id);
    await failure(
      f.money.create(f.admin, "provider_settlement", {
        ...input,
        providerId: "provider-official",
      }),
      "REASON_REQUIRED",
    );
    let queue = await f.money.adminSummary(
      f.admin,
      new URLSearchParams("kind=refund&history=false&page=1"),
    );
    assert.equal(queue.total, 1);
    assert.equal(queue.pendingCounts[0].count, 1);
    await f.money.decide(f.admin, r.id, {
      action: "reject",
      note: "收款地址需要重新核对",
    });
    assert.equal(
      (await f.money.list(f.user))[0].rejection_reason,
      "收款地址需要重新核对",
    );
    queue = await f.money.adminSummary(
      f.admin,
      new URLSearchParams("kind=refund&history=false&page=1"),
    );
    assert.equal(queue.total, 0);
    assert.equal(queue.records.length, 0);
    assert.equal(
      (
        await f.money.adminSummary(
          f.admin,
          new URLSearchParams("kind=refund&history=true&page=1"),
        )
      ).total,
      1,
    );
    assert.equal(await f.balance(), "100.000000");
    await failure(f.money.adminSummary(f.user), "FORBIDDEN");
  } finally {
    await f.db.close();
  }
});
