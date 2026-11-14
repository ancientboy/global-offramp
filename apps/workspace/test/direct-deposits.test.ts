import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DirectFunding } from "../src/direct-funding";
import { TronDeposits, type IncomingTransfer } from "../src/tron-deposits";
import {
  address,
  addressHex,
  TRANSFER_TOPIC,
  TRON_USDT,
} from "../src/chain-transfers";
import { USDT_TRC20_RECEIVER } from "../../../packages/core/src/deposit-policy";
import { financialReport } from "../src/financial-report";
import { moneyFixture, TSOURCE } from "./helpers/money";
import { units } from "../../../packages/core/src/money";
class Discovery extends TronDeposits {
  transfers: IncomingTransfer[] = [];
  unavailable = false;
  failDiscovery = false;
  override async solidTime() {
    if (this.unavailable) throw Error("unavailable");
    return Date.now();
  }
  override async discover() {
    if (this.failDiscovery) throw Error("pagination unavailable");
    return this.transfers.map((t) => t.txid);
  }
  override async verify(id: string) {
    return this.transfers.filter((t) => t.txid === id);
  }
}
const input = {
  currency: "USDT",
  network: "usdttrc20",
  amount: "100",
  idempotencyKey: "direct-deposit-1",
};
function incoming(
  amount: string,
  time = Date.now(),
  id = "ab".repeat(32),
): IncomingTransfer {
  return {
    amount,
    time,
    txid: id,
    logIndex: 0,
    sourceHex: addressHex("usdttrc20", TSOURCE),
    blockNumber: 90000000,
    blockHash: "cd".repeat(32),
  };
}
async function fixture() {
  const f = await moneyFixture(),
    chain = new Discovery(),
    funding = new DirectFunding(
      f.auth,
      f.provider,
      "https://workspace.example",
      "live",
      true,
      chain,
    );
  await funding.tick();
  return { ...f, chain, funding };
}
const denied = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: any) => e.code === code);
test("direct deposits pin the checked address, atomically allocate unique nonreused suffixes and reject other assets", async () => {
  const f = await fixture();
  try {
    assert.equal(
      address("usdttrc20", USDT_TRC20_RECEIVER),
      USDT_TRC20_RECEIVER,
    );
    assert.deepEqual(
      f.funding.publicConfig().networks.map((n) => n.id),
      ["usdttrc20"],
    );
    const p = await f.funding.create(f.user, input),
      q = await f.funding.create(f.user, {
        ...input,
        idempotencyKey: "direct-deposit-2",
      });
    assert.equal(p.source, "direct_tron");
    assert.equal(p.pay_address, USDT_TRC20_RECEIVER);
    assert.match(p.pay_amount, /^100\.00\d{4}$/);
    assert.notEqual(p.pay_amount, q.pay_amount);
    assert.equal((await f.funding.create(f.user, input)).id, p.id);
    await denied(
      f.funding.create(f.user, { ...input, amount: "101" }),
      "IDEMPOTENCY_CONFLICT",
    );
    await assert.rejects(
      f.funding.create(f.user, {
        ...input,
        currency: "USDC",
        network: "usdcbase",
      }),
    );
    await assert.rejects(
      f.funding.create(f.user, { ...input, network: "usdtbsc" }),
    );
    await assert.rejects(
      f.funding.create(f.user, { ...input, amount: "1.000001" }),
    );
    await assert.rejects(
      f.pool.query(
        "UPDATE workspace.funding_payments SET pay_address=$2 WHERE id=$1",
        [p.id, TSOURCE],
      ),
    );
    await assert.rejects(
      f.pool.query(
        "UPDATE workspace.funding_payments SET pay_amount='200.000001' WHERE id=$1",
        [p.id],
      ),
    );
    await assert.rejects(
      f.pool.query("UPDATE workspace.direct_deposit_scan SET receiver=$1", [
        TSOURCE,
      ]),
    );
    await f.pool.query(
      "UPDATE workspace.funding_payments SET status='expired' WHERE id=$1",
      [p.id],
    );
    const r = await f.funding.create(f.user, {
      ...input,
      idempotencyKey: "direct-deposit-3",
    });
    assert.notEqual(r.pay_amount, p.pay_amount);
    const large = await f.funding.create(f.user, {
      ...input,
      amount: "100000000",
      idempotencyKey: "direct-large-deposit",
    });
    assert.equal(large.requested_amount, "100000000.000000");
  } finally {
    await f.db.close();
  }
});
test("only exact timely finalized receipts credit once; suffix is fully credited and reconciles separately from legacy custody", async () => {
  const f = await fixture();
  try {
    const p = await f.funding.create(f.user, input);
    f.chain.transfers = [incoming(p.pay_amount)];
    await f.funding.tick();
    await f.funding.tick();
    const row = (await f.funding.list(f.user)).find((r) => r.id === p.id)!;
    assert.equal(row.status, "credited");
    assert.equal(row.credited_amount, p.pay_amount);
    const evidence = (
      await f.pool.query("SELECT * FROM workspace.direct_deposit_claims")
    ).rows;
    assert.equal(evidence.length, 1);
    const lines = (
      await f.pool.query(
        "SELECT sum(debit)::numeric(30,6)::text total FROM runtime.ledger_lines WHERE account='asset:treasury:direct_tron'",
      )
    ).rows[0];
    assert.equal(units(lines.total, 6), units(p.pay_amount, 6));
    const report = await financialReport(f.auth, f.admin);
    assert(report.rows.every((r) => r.depositsMatch && r.ledgerBalanced));
    assert(
      (await f.funding.summary(f.admin)).reconciliation.every((r) => r.matches),
    );
    await assert.rejects(
      f.pool.query("DELETE FROM workspace.direct_deposit_events"),
    );
    await assert.rejects(
      f.pool.query(
        "INSERT INTO workspace.chain_transfer_claims(network,txid,log_index,movement_id,block_number,block_hash,source_address) VALUES('usdttrc20',$1,0,'nonexistent','90000000',$2,$3)",
        [f.chain.transfers[0].txid, "cd".repeat(32), TSOURCE],
      ),
      /incoming transfer/,
    );
  } finally {
    await f.db.close();
  }
});
test("underpayment, late transfers and old receipts never auto-credit; reviewed assignment uses actual amount and cannot redirect another order", async () => {
  const f = await fixture();
  try {
    const p = await f.funding.create(f.user, input),
      q = await f.funding.create(f.user, {
        ...input,
        idempotencyKey: "direct-deposit-2",
      });
    const under = incoming("99.000000"),
      late = incoming(
        q.pay_amount,
        Date.parse(q.expires_at) + 1000,
        "ef".repeat(32),
      );
    f.chain.transfers = [under, late];
    await f.funding.tick();
    assert.equal(
      (await f.funding.list(f.user)).find((r) => r.id === p.id)!
        .credited_amount,
      null,
    );
    const summary = await f.funding.summary(f.admin);
    assert.equal(summary.unmatched.length, 2);
    await denied(
      f.funding.resolve(f.user, p.id, {
        decision: "assign_transfer",
        txid: under.txid,
        logIndex: 0,
        note: "Verified payer belongs to this customer",
      }),
      "FORBIDDEN",
    );
    await denied(
      f.funding.resolve(f.admin, p.id, {
        decision: "assign_transfer",
        txid: late.txid,
        logIndex: 0,
        note: "Cannot redirect an allocated amount",
      }),
      "TRANSFER_MISMATCH",
    );
    await f.funding.resolve(f.admin, p.id, {
      decision: "assign_transfer",
      txid: under.txid,
      logIndex: 0,
      note: "Verified payer belongs to this customer",
    });
    assert.equal(
      (await f.funding.list(f.user)).find((r) => r.id === p.id)!
        .credited_amount,
      "99.000000",
    );
    await denied(
      f.funding.resolve(f.admin, q.id, {
        decision: "assign_transfer",
        txid: under.txid,
        logIndex: 0,
        note: "Attempt duplicate assignment to another order",
      }),
      "TRANSFER_ALREADY_CLAIMED",
    );
  } finally {
    await f.db.close();
  }
});
test("discovery outages do not advance cursor or credit funds; stale monitoring stops new payment instructions", async () => {
  const f = await fixture();
  try {
    const before = (
      await f.pool.query(
        "SELECT scanned_through FROM workspace.direct_deposit_scan",
      )
    ).rows[0];
    f.chain.failDiscovery = true;
    await assert.rejects(f.funding.tick());
    assert.deepEqual(
      (
        await f.pool.query(
          "SELECT scanned_through FROM workspace.direct_deposit_scan",
        )
      ).rows[0],
      before,
    );
    await f.pool.query(
      "UPDATE workspace.direct_deposit_scan SET checked_at=now()-interval '10 minutes'",
    );
    await denied(f.funding.create(f.user, input), "CHAIN_MONITOR_UNAVAILABLE");
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int n FROM workspace.direct_deposit_claims",
        )
      ).rows[0].n,
      0,
    );
  } finally {
    await f.db.close();
  }
});
test("native incoming verification validates canonical solidified success, genuine USDT logs and the pinned destination", async () => {
  const raw = "11223344",
    txid = createHash("sha256").update(Buffer.from(raw, "hex")).digest("hex"),
    time = Date.now();
  const log = {
    address: addressHex("usdttrc20", TRON_USDT),
    topics: [
      TRANSFER_TOPIC,
      addressHex("usdttrc20", TSOURCE).padStart(64, "0"),
      addressHex("usdttrc20", USDT_TRC20_RECEIVER).padStart(64, "0"),
    ],
    data: 100000123n.toString(16).padStart(64, "0"),
  };
  const info: any = {
      id: txid,
      receipt: { result: "SUCCESS" },
      blockNumber: 100,
      blockTimeStamp: time,
      log: [log],
    },
    tx: any = {
      txID: txid,
      raw_data_hex: raw,
      ret: [{ contractRet: "SUCCESS" }],
    },
    block: any = {
      blockID: "cd".repeat(32),
      block_header: { raw_data: { number: 100, timestamp: time } },
      transactions: [{ txID: txid }],
    };
  const chain = new TronDeposits("", async (u) =>
    Response.json(
      String(u).includes("gettransactioninfobyid")
        ? info
        : String(u).includes("gettransactionbyid")
          ? tx
          : block,
    ),
  );
  assert.equal((await chain.verify(txid))[0].amount, "100.000123");
  log.address = addressHex("usdttrc20", TSOURCE);
  assert.equal((await chain.verify(txid)).length, 0);
  log.address = addressHex("usdttrc20", TRON_USDT);
  log.topics[2] = addressHex("usdttrc20", TSOURCE).padStart(64, "0");
  assert.equal((await chain.verify(txid)).length, 0);
  log.topics[2] = addressHex("usdttrc20", USDT_TRC20_RECEIVER).padStart(
    64,
    "0",
  );
  info.receipt.result = "REVERT";
  await assert.rejects(chain.verify(txid));
  info.receipt.result = "SUCCESS";
  block.transactions = [];
  await assert.rejects(chain.verify(txid));
  block.transactions = [{ txID: txid }];
  tx.raw_data_hex = "11223345";
  await assert.rejects(chain.verify(txid));
});
test("indexer pagination is bounded, deduplicated and fail closed", async () => {
  let n = 0;
  const id = "ab".repeat(32);
  const chain = new TronDeposits("", async () => {
    n++;
    return Response.json({
      success: true,
      data: [{ transaction_id: id }],
      meta: n === 1 ? { fingerprint: "next" } : {},
    });
  });
  assert.deepEqual(await chain.discover(1, 2), [id]);
  assert.equal(n, 2);
  const stalled = new TronDeposits("", async () =>
    Response.json({
      success: true,
      data: [{ transaction_id: id }],
      meta: { fingerprint: "stalled" },
    }),
  );
  await assert.rejects(stalled.discover(1, 2), /stalled/);
});

test("USDT-only runtime rejects stale USDC quotes, CSV imports and withdrawals while preserving historical records", async () => {
  const f = await fixture();
  try {
    const { workspaceApp } = await import("../src/app"),
      { MoneyMovements } = await import("../src/money-movements");
    const money = new MoneyMovements(
      f.auth,
      f.money.chain,
      "live",
      null,
      null,
      true,
    );
    await denied(
      money.create(f.user, "refund", {
        currency: "USDC",
        network: "usdcbase",
        amount: "1",
        destination: "0x2222222222222222222222222222222222222222",
        idempotencyKey: "usdc-disabled-refund",
      }),
      "UNSUPPORTED_CURRENCY",
    );
    const app = workspaceApp(f.auth, {} as any, "https://workspace.example", {
      funding: f.funding,
      usdtOnly: true,
    });
    const login = await app(
      new Request("https://workspace.example/workspace/api/auth/login", {
        method: "POST",
        headers: {
          origin: "https://workspace.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          identifier: "money-user@example.com",
          password: "isolated-money-password-84",
        }),
      }),
      "127.0.0.1",
    );
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    for (const [path, body] of [
      ["quotes", { sourceCurrency: "USDC" }],
      ["batches", { csv: "clientItemId,sourceCurrency\none,USDC\n" }],
      ["routes/USDC-USD/draft", {}],
    ] as const) {
      const r = await app(
        new Request("https://workspace.example/workspace/api/" + path, {
          method: "POST",
          headers: {
            origin: "https://workspace.example",
            "content-type": "application/json",
            cookie,
          },
          body: JSON.stringify(body),
        }),
        "127.0.0.1",
      );
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, "UNSUPPORTED_CURRENCY");
    }
    const list = await f.funding.list(f.user);
    assert(list.some((p) => p.currency === "USDC")); // immutable history stays intact
  } finally {
    await f.db.close();
  }
});

test("read-only TRON requests pace bursts, retry throttling and never treat failed reads as confirmed data", async () => {
  let attempts = 0;
  const times: number[] = [];
  const c = new TronDeposits("", async () => {
    times.push(Date.now());
    attempts++;
    return attempts === 1
      ? Response.json({ error: "limited" }, { status: 429 })
      : Response.json({
          blockID: "ab".repeat(32),
          block_header: { raw_data: { timestamp: Date.now() } },
        });
  });
  assert(await c.solidTime());
  assert.equal(attempts, 2);
  assert(times[1] - times[0] >= 1400);
  let denied = 0;
  const d = new TronDeposits("", async () => {
    denied++;
    return Response.json({ error: "unauthorized" }, { status: 401 });
  });
  await assert.rejects(d.solidTime(), /401/);
  assert.equal(denied, 1);
  const failures = new TronDeposits("", async () =>
    Response.json({ error: "unavailable" }, { status: 503 }),
  );
  await assert.rejects(failures.solidTime(), /503/);
});
