import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { Auth, type Account } from "../../src/auth";
import {
  PostgresStore,
  type SqlPool,
} from "../../../../packages/core/src/store";
import { fixtureState } from "../../../../packages/core/src/fixtures";
import { OfframpService } from "../../../../packages/core/src/service";
import { NowPayments } from "../../src/nowpayments";
import { Funding, bindFundsMode } from "../../src/funding";
import { MoneyMovements } from "../../src/money-movements";
import {
  ChainTransfers,
  addressHex,
  TRANSFER_TOPIC,
  BASE_USDC,
  TRON_USDT,
} from "../../src/chain-transfers";
import { AccountSecurity } from "../../src/account-security";
import { workspaceApp } from "../../src/app";
export const PASSWORD = "isolated-money-password-84",
  SOURCE = "0x1111111111111111111111111111111111111111",
  DEST = "0x2222222222222222222222222222222222222222",
  TX = "0x" + "ab".repeat(32),
  TRX = "bc".repeat(32);
export function tronAddress(byte: number) {
  const body = Buffer.concat([Buffer.from([0x41]), Buffer.alloc(20, byte)]),
    h = (b: Buffer) => createHash("sha256").update(b).digest();
  let n = BigInt(
      "0x" + Buffer.concat([body, h(h(body)).subarray(0, 4)]).toString("hex"),
    ),
    s = "";
  const chars = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  while (n) {
    s = chars[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
}
export const TSOURCE = tronAddress(17),
  TDEST = tronAddress(34);
export function event(
  amount: string,
  network: "usdcbase" | "usdttrc20" = "usdcbase",
  index = 7,
) {
  const [whole, frac = ""] = amount.split("."),
    raw = BigInt(whole) * 1000000n + BigInt((frac + "000000").slice(0, 6));
  const source = network === "usdcbase" ? SOURCE : TSOURCE,
    dest = network === "usdcbase" ? DEST : TDEST;
  return {
    address:
      network === "usdcbase" ? BASE_USDC : addressHex("usdttrc20", TRON_USDT),
    topics: [
      "0x" + TRANSFER_TOPIC,
      "0x" + addressHex(network, source).padStart(64, "0"),
      "0x" + addressHex(network, dest).padStart(64, "0"),
    ],
    data: "0x" + raw.toString(16).padStart(64, "0"),
    logIndex: "0x" + index.toString(16),
    transactionHash: TX,
    blockHash: "0x" + "12".repeat(32),
    removed: false,
  };
}
export function chainHarness() {
  const state: any = {
    chainId: "0x2105",
    finalized: "0x200",
    receipt: {
      transactionHash: TX,
      status: "0x1",
      blockNumber: "0x100",
      blockHash: "0x" + "12".repeat(32),
      logs: [event("5")],
    },
    tronInfo: {
      id: TRX,
      blockNumber: 256,
      blockTimeStamp: Date.now(),
      receipt: { result: "SUCCESS" },
      log: [event("5", "usdttrc20")],
    },
    failed: false,
  };
  const fetcher: typeof fetch = async (url, options) => {
    if (state.failed) throw Error("offline");
    const b = JSON.parse(String(options?.body ?? "{}"));
    if (String(url).includes("mainnet.base.org")) {
      let result: any;
      if (b.method === "eth_chainId") result = state.chainId;
      if (b.method === "eth_getTransactionReceipt") result = state.receipt;
      if (b.method === "eth_getBlockByNumber")
        result =
          b.params[0] === "finalized"
            ? { number: state.finalized }
            : {
                number: "0x100",
                hash: state.blockHash ?? "0x" + "12".repeat(32),
                timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16),
              };
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    }
    if (String(url).endsWith("gettransactioninfobyid"))
      return Response.json(state.tronInfo);
    if (String(url).endsWith("gettransactionbyid"))
      return Response.json({ txID: TRX, ret: [{ contractRet: "SUCCESS" }] });
    if (String(url).endsWith("getblockbynum"))
      return Response.json({
        blockID: "de".repeat(32),
        block_header: {
          raw_data: { number: 256, timestamp: state.tronInfo.blockTimeStamp },
        },
      });
    throw Error("unexpected RPC");
  };
  return {
    state,
    chain: new ChainTransfers(
      { usdcbase: [SOURCE], usdttrc20: [TSOURCE] },
      fetcher,
    ),
  };
}
export async function moneyFixture() {
  const db = new PGlite();
  await db.exec(readFileSync("db-runtime.sql", "utf8"));
  for (const n of readdirSync("db/migrations")
    .filter((n) => /^\d.*\.sql$/.test(n) && Number(n.slice(0, 3)) >= 2)
    .sort())
    await db.exec(readFileSync("db/migrations/" + n, "utf8"));
  let tail: Promise<void> = Promise.resolve();
  async function lease() {
    const before = tail;
    let release!: () => void;
    tail = new Promise<void>((r) => (release = r));
    await before;
    return release;
  }
  const pool: SqlPool = {
      query: async (q, p) => {
        const unlock = await lease();
        try {
          return await db.query(q, p);
        } finally {
          unlock();
        }
      },
      connect: async () => {
        const unlock = await lease();
        return { query: (q, p) => db.query(q, p), release: unlock };
      },
    },
    store = new PostgresStore(pool),
    state = fixtureState();
  state.customers = [];
  state.beneficiaries = [];
  await store.initialize(state);
  const auth = new Auth(pool, store, () => Date.now(), Buffer.alloc(32, 7));
  const customer = await auth.register({
    email: "money-user@example.com",
    password: PASSWORD,
    name: "Money User",
    kind: "personal",
  });
  await auth.createAdmin(
    { username: "moneyadmin", password: PASSWORD },
    "Money Admin",
  );
  const admin = (
      await pool.query(
        "SELECT * FROM workspace.accounts WHERE username='moneyadmin'",
      )
    ).rows[0] as Account,
    user = (
      await pool.query("SELECT * FROM workspace.accounts WHERE id=$1", [
        customer.id,
      ])
    ).rows[0] as Account;
  await store.transaction((s) => {
    s.customers[0].status = "approved";
    s.beneficiaries.push({
      ...fixtureState().beneficiaries[0],
      id: "money-recipient",
      customerId: customer.customerId!,
    });
  });
  await bindFundsMode(auth, "live", false);
  let i = 100;
  const payments = new Map<string, any>();
  const provider = new NowPayments(
    "test-only",
    "test-secret",
    false,
    async (url, options) => {
      if (String(url).includes("min-amount"))
        return Response.json({ min_amount: 1 });
      if (options?.method === "POST") {
        const v = JSON.parse(String(options.body)),
          p = {
            ...v,
            payment_id: ++i,
            pay_address: "test-address-" + i,
            pay_amount: v.price_amount,
            payment_status: "waiting",
            outcome_currency: v.pay_currency,
            outcome_amount: 0,
          };
        payments.set(String(i), p);
        return Response.json(p);
      }
      return Response.json(payments.get(String(url).split("/").at(-1)!) ?? {});
    },
  );
  const funding = new Funding(
    auth,
    provider,
    "https://workspace.example",
    "live",
    ["usdcbase", "usdttrc20"],
    true,
  );
  const p = await funding.create(user, {
    currency: "USDC",
    network: "usdcbase",
    amount: "100",
    idempotencyKey: "initial-deposit",
  });
  Object.assign(payments.get("101"), {
    payment_status: "finished",
    outcome_amount: 100,
  });
  await funding.refresh({ id: p.id, provider_id: "101" });
  const chain = chainHarness(),
    money = new MoneyMovements(auth, chain.chain, "live"),
    security = new AccountSecurity(auth, auth.securityKey!);
  const app = workspaceApp(auth, {} as any, "https://workspace.example", {
    funding,
    money,
    security,
    fundsMode: "live",
    payoutsPaused: false,
  });
  async function balance() {
    const d = await new OfframpService(store).dashboard({
      id: user.id,
      role: "customer",
      customerId: user.customer_id!,
    });
    return d.walletBalances!.find((b) => b.currency === "USDC")!.available;
  }
  return {
    db,
    pool,
    store,
    auth,
    admin,
    user,
    funding,
    provider,
    payments,
    money,
    chain,
    security,
    app,
    balance,
    core: new OfframpService(store, () => new Date(), undefined, "live"),
  };
}
export const refundInput = {
  currency: "USDC",
  network: "usdcbase",
  amount: "5",
  destination: DEST,
  reason: "退回未使用余额",
  idempotencyKey: "refund-request-1",
};
