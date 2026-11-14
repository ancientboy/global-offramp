import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PostgresStore, type SqlPool } from "../../../packages/core/src/store";
import { fixtureState } from "../../../packages/core/src/fixtures";
import { OfframpService } from "../../../packages/core/src/service";
import { Auth, type Account } from "../src/auth";
import { AccountSecurity } from "../src/account-security";
import { totp, totpCounter, sealSecret, openSecret } from "../src/totp";
import { Funding, bindFundsMode } from "../src/funding";
import { NowPayments, sortKeys, verifyIpn, decimal6 } from "../src/nowpayments";
import { workspaceApp } from "../src/app";
const password = "test-long-password-6942",
  key = Buffer.alloc(32, 4),
  secret = "test-ipn-secret-only";
async function fixture() {
  const db = new PGlite();
  for (const name of [
    "db-runtime.sql",
    "db/migrations/002_workspace.sql",
    "db/migrations/003_route_drafts.sql",
    "db/migrations/004_operator_customer_username.sql",
    "db/migrations/005_multi_fiat.sql",
    "db/migrations/006_provider_accounts.sql",
    "db/migrations/007_partner_invites.sql",
    "db/migrations/008_funding_security.sql",
    "db/migrations/009_funding_observation_sequence.sql",
    "db/migrations/010_money_movements.sql",
  ])
    await db.exec(readFileSync(name, "utf8"));
  const pool: SqlPool = {
    query: (s, p) => db.query(s, p),
    connect: async () => ({ query: (s, p) => db.query(s, p) }),
  };
  const store = new PostgresStore(pool),
    state = fixtureState();
  state.customers = [];
  state.beneficiaries = [];
  await store.initialize(state);
  let now = Date.now();
  const auth = new Auth(pool, store, () => now, key);
  const user = await auth.register({
    email: "user@example.com",
    password,
    name: "User",
    kind: "personal",
  });
  // Exercise first-use gates using a legacy/operator-initialized account.
  await pool.query(
    "UPDATE workspace.account_security SET password_changed_at=NULL WHERE account_id=$1",
    [user.id],
  );
  const account = (
    await pool.query("SELECT * FROM workspace.accounts WHERE id=$1", [user.id])
  ).rows[0] as Account;
  await store.transaction((s) => {
    s.customers.find((c) => c.id === user.customerId)!.status = "approved";
  });
  const providerPayments = new Map<string, any>();
  let creates = 0;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("min-amount")) return Response.json({ min_amount: 5 });
    if (init?.method === "POST") {
      creates++;
      const v = JSON.parse(String(init.body)),
        payment = {
          ...v,
          payment_id: 100 + creates,
          pay_currency: v.pay_currency,
          pay_address: "test-provider-address-" + creates,
          pay_amount: v.price_amount,
          payment_status: "waiting",
          outcome_currency: v.pay_currency,
          outcome_amount: 0,
        };
      providerPayments.set(String(payment.payment_id), payment);
      return Response.json(payment);
    }
    const payment = providerPayments.get(path.split("/").at(-1)!);
    return Response.json(payment ?? {}, { status: payment ? 200 : 404 });
  };
  const provider = new NowPayments("test-only-api-key", secret, false, fetcher),
    funding = new Funding(
      auth,
      provider,
      "https://workspace.example",
      "live",
      ["usdttrc20", "usdcbase"],
      true,
      "1000",
      "1500",
    ),
    security = new AccountSecurity(auth, key);
  const app = workspaceApp(auth, {} as any, "https://workspace.example", {
    funding,
    security,
    fundsMode: "live",
    payoutsPaused: true,
  });
  return {
    db,
    pool,
    store,
    auth,
    account,
    funding,
    security,
    providerPayments,
    app,
    advance: (ms: number) => (now += ms),
    now: () => now,
    creates: () => creates,
  };
}
const request = {
  currency: "USDT",
  network: "usdttrc20",
  amount: "100",
  idempotencyKey: "payment-test-key",
};
test("TOTP matches RFC vector, checks freshness, and encryption is bound to the account", () => {
  const s = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  assert.equal(totp(s, 1), "287082");
  assert.equal(totpCounter(s, "287082", 59000), 1);
  assert.equal(totpCounter(s, "287082", 59000, 1), -1);
  const sealed = sealSecret(key, "account-a", s);
  assert.equal(openSecret(key, "account-a", sealed), s);
  assert.throws(() => openSecret(key, "account-b", sealed));
  assert.equal(decimal6("999.123456789"), "999.123456");
  assert.throws(() => decimal6("-1"));
  assert.throws(() => decimal6("1e20"));
});
test("IPN recursively canonicalizes nested data and rejects tampering and oversized requests", () => {
  const value = {
    payment_id: 123,
    fee: { withdrawalFee: 1, depositFee: 2 },
    payment_status: "finished",
  };
  const sig = createHmac("sha512", secret)
    .update(JSON.stringify(sortKeys(value)))
    .digest("hex");
  assert.equal(
    verifyIpn(JSON.stringify(value), sig, secret).value.payment_id,
    123,
  );
  assert.throws(() =>
    verifyIpn(JSON.stringify({ ...value, payment_id: 124 }), sig, secret),
  );
  assert.throws(() => verifyIpn(" ".repeat(65537), sig, secret));
});
test("real deposits are exact-once, net-settled, owner-scoped and never trust a callback's amount", async () => {
  const f = await fixture();
  try {
    await bindFundsMode(f.auth, "live", false);
    const p = await f.funding.create(f.account, request);
    assert.equal(p.status, "waiting");
    assert.equal(f.creates(), 1);
    assert.equal((await f.funding.create(f.account, request)).id, p.id);
    assert.equal(f.creates(), 1);
    await assert.rejects(
      () => f.funding.create(f.account, { ...request, amount: "101" }),
      /IDEMPOTENCY_CONFLICT/,
    );
    const provider = f.providerPayments.get("101");
    const raw = JSON.stringify({
        payment_id: 101,
        payment_status: "finished",
        outcome_amount: 99999,
      }),
      sig = createHmac("sha512", secret)
        .update(JSON.stringify(sortKeys(JSON.parse(raw))))
        .digest("hex");
    await f.funding.ipn(raw, sig);
    await f.funding.ipn(raw, sig);
    assert.equal(
      (await f.pool.query("SELECT * FROM workspace.funding_inbox")).rows.length,
      1,
    );
    await f.funding.refresh({ id: p.id, provider_id: "101" });
    assert.equal((await f.store.read()).journals.length, 0);
    provider.payment_status = "finished";
    provider.outcome_amount = "98.12345678";
    await f.funding.refresh({ id: p.id, provider_id: "101" });
    await f.funding.refresh({ id: p.id, provider_id: "101" });
    const state = await f.store.read();
    assert.equal(state.journals.length, 1);
    const summary = await f.funding.summary({
      ...f.account,
      role: "merchant_admin",
    });
    assert.ok(summary.reconciliation.every((r) => r.matches));
    assert.equal(state.journals[0].lines[1].credit, "98.123456");
    const dashboard = await new OfframpService(f.store).dashboard({
      id: f.account.id,
      role: "customer",
      customerId: f.account.customer_id!,
    });
    assert.equal(dashboard.walletBalances![0].available, "98.123456");
    const payments = await f.funding.list({
      ...f.account,
      customer_id: "foreign-customer",
    });
    assert.equal(payments.length, 0);
    await assert.rejects(
      () => f.funding.list({ ...f.account, role: "partner" }),
      /FORBIDDEN/,
    );
    provider.outcome_amount = "101";
    await f.funding.refresh({ id: p.id, provider_id: "101" });
    assert.equal((await f.store.read()).journals.length, 1);
    assert.equal((await f.funding.list(f.account))[0].status, "review");
    assert.equal(
      (await f.pool.query("SELECT kind FROM workspace.operational_alerts"))
        .rows[0].kind,
      "CREDITED_PAYMENT_CHANGED",
    );
  } finally {
    await f.db.close();
  }
});
test("wrong asset, partial, identity mismatch, limits and ambiguous creates never silently credit", async () => {
  const f = await fixture();
  try {
    for (const [change, id] of [
      [
        { payment_status: "partially_paid", outcome_amount: 99 },
        "partial-test",
      ],
      [
        {
          payment_status: "finished",
          outcome_amount: 100,
          outcome_currency: "btc",
        },
        "wrong-asset",
      ],
      [
        {
          payment_status: "finished",
          outcome_amount: 100,
          order_id: "foreign-order",
        },
        "wrong-owner",
      ],
    ] as const) {
      const p = await f.funding.create(f.account, {
        ...request,
        idempotencyKey: id,
      });
      const providerId = String(100 + f.creates());
      Object.assign(f.providerPayments.get(providerId), change);
      await f.funding.refresh({ id: p.id, provider_id: providerId });
      assert.equal(
        (await f.funding.list(f.account)).find((x) => x.id === p.id).status,
        "review",
      );
    }
    assert.equal((await f.store.read()).journals.length, 0);
    await assert.rejects(
      () => f.funding.create(f.account, { ...request, network: "btc" }),
      /UNSUPPORTED_NETWORK/,
    );
    await assert.rejects(
      () => f.funding.create(f.account, { ...request, amount: "1001" }),
      /DEPOSIT_LIMIT_EXCEEDED/,
    );
    await assert.rejects(
      () => f.funding.create(f.account, { ...request, amount: "1" }),
      /BELOW_DEPOSIT_MINIMUM/,
    );
    await f.funding.create(f.account, {
      ...request,
      amount: "1000",
      idempotencyKey: "large-first",
    });
    await assert.rejects(
      () =>
        f.funding.create(f.account, {
          ...request,
          amount: "300",
          idempotencyKey: "over-daily-limit",
        }),
      /DAILY_DEPOSIT_LIMIT/,
    );
    const provider = new NowPayments("test", secret, false, async () => {
      throw Error("timeout");
    });
    provider.minimum = async () => "1";
    const unknown = new Funding(
      f.auth,
      provider,
      "https://workspace.example",
      "live",
      ["usdttrc20"],
      true,
    );
    await assert.rejects(() =>
      unknown.create(f.account, {
        ...request,
        idempotencyKey: "ambiguous-create",
      }),
    );
    assert.equal(
      (
        await unknown.create(f.account, {
          ...request,
          idempotencyKey: "ambiguous-create",
        })
      ).status,
      "creation_unknown",
    );
  } finally {
    await f.db.close();
  }
});
test("funds environment cannot be switched or contaminated with simulated money", async () => {
  const f = await fixture();
  try {
    await bindFundsMode(f.auth, "sandbox", true);
    await assert.rejects(
      () => bindFundsMode(f.auth, "live", false),
      /immutable/,
    );
    await assert.rejects(() => bindFundsMode(f.auth, "live", true));
  } finally {
    await f.db.close();
  }
});
test("password change revokes other sessions; TOTP and recovery codes are one-use, mandatory after enrollment", async () => {
  const f = await fixture();
  try {
    const first = await f.auth.login(
      { identifier: f.account.email, password },
      "test-ip",
    );
    const second = await f.auth.login(
      { identifier: f.account.email, password },
      "test-ip",
    );
    await f.security.password(
      f.account,
      { currentPassword: password, password: "new-long-secure-password-834" },
      first.token,
    );
    await assert.rejects(() => f.auth.current(second.token), /SESSION_EXPIRED/);
    await f.auth.current(first.token);
    const setup = await f.security.setup(f.account, {
      password: "new-long-secure-password-834",
    });
    const stored = (
      await f.pool.query("SELECT * FROM workspace.account_security")
    ).rows[0];
    assert.ok(!stored.pending_secret.includes(setup.secret));
    const enrollment = await f.security.confirm(
      f.account,
      { code: totp(setup.secret, Math.floor(f.now() / 30000)) },
      first.token,
    );
    assert.equal(enrollment.recoveryCodes.length, 8);
    await assert.rejects(
      () =>
        f.auth.login(
          {
            identifier: f.account.email,
            password: "new-long-secure-password-834",
          },
          "test-ip",
        ),
      /MFA_REQUIRED/,
    );
    await assert.rejects(
      () =>
        f.auth.login(
          {
            identifier: f.account.email,
            password: "new-long-secure-password-834",
            code: totp(setup.secret, Math.floor(f.now() / 30000)),
          },
          "test-ip",
        ),
      /INVALID_OTP/,
    );
    f.advance(30000);
    const login = await f.auth.login(
      {
        identifier: f.account.email,
        password: "new-long-secure-password-834",
        code: totp(setup.secret, Math.floor(f.now() / 30000)),
      },
      "test-ip",
    );
    await f.auth.current(login.token);
    await f.auth.login(
      {
        identifier: f.account.email,
        password: "new-long-secure-password-834",
        code: enrollment.recoveryCodes[0],
      },
      "test-ip",
    );
    await assert.rejects(
      () =>
        f.auth.login(
          {
            identifier: f.account.email,
            password: "new-long-secure-password-834",
            code: enrollment.recoveryCodes[0],
          },
          "test-ip",
        ),
      /INVALID_OTP/,
    );
  } finally {
    await f.db.close();
  }
});

test("live API exempts only signed provider callbacks; browser money actions require password setup and staff step-up", async () => {
  const f = await fixture();
  try {
    const login = await f.auth.login(
      { identifier: f.account.email, password },
      "http-test",
    );
    const cookie = "__Secure-offramp-workspace=" + login.token;
    async function call(
      path: string,
      body?: unknown,
      headers: Record<string, string> = {},
    ) {
      return f.app(
        new Request("https://workspace.example/workspace/api/" + path, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin: "https://workspace.example",
            "content-type": "application/json",
            cookie,
            ...headers,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        "test-client",
      );
    }
    assert.equal((await call("auth/security")).status, 200);
    const gated = await call("wallet/funding/payments", request);
    assert.equal((await gated.json()).error, "PASSWORD_CHANGE_REQUIRED");
    assert.equal(
      (
        await call("wallet/funding/payments", request, {
          origin: "https://attacker.example",
        })
      ).status,
      403,
    );
    const raw = { payment_id: 123, payment_status: "finished" },
      signature = createHmac("sha512", secret)
        .update(JSON.stringify(sortKeys(raw)))
        .digest("hex");
    assert.equal(
      (
        await call("payments/nowpayments/ipn", raw, {
          origin: "https://provider.example",
          cookie: "",
          "x-nowpayments-sig": signature,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call("payments/nowpayments/ipn", raw, {
          origin: "https://provider.example",
          cookie: "",
          "x-nowpayments-sig": "a".repeat(128),
        })
      ).status,
      401,
    );
    await f.security.password(
      f.account,
      { currentPassword: password, password: "http-new-password-long-493" },
      login.token,
    );
    // Pausing payouts must never accidentally disable incoming deposits.
    assert.equal((await call("wallet/funding/payments", request)).status, 201);
    await assert.rejects(
      () =>
        f.security.requireReady(
          { ...f.account, role: "merchant_admin" },
          login.token,
          true,
        ),
      /MFA_SETUP_REQUIRED/,
    );
  } finally {
    await f.db.close();
  }
});

test("live wallet reservation and provider attestation preserve treasury assets and record a settlement payable, never mock cash movement", async () => {
  const f = await fixture();
  try {
    await bindFundsMode(f.auth, "live", false);
    const p = await f.funding.create(f.account, request);
    Object.assign(f.providerPayments.get("101"), {
      payment_status: "finished",
      outcome_amount: 100,
    });
    await f.funding.refresh({ id: p.id, provider_id: "101" });
    await f.store.transaction((s) => {
      s.beneficiaries.push({
        ...fixtureState().beneficiaries[0],
        id: "live-beneficiary",
        customerId: f.account.customer_id!,
      });
    });
    const core = new OfframpService(
        f.store,
        () => new Date(f.now()),
        undefined,
        "live",
      ),
      actor = {
        id: f.account.id,
        role: "customer" as const,
        customerId: f.account.customer_id!,
      };
    await assert.rejects(
      () =>
        core.depositWallet(actor, {
          customerId: f.account.customer_id,
          currency: "USDT",
          amount: "10",
          idempotencyKey: "forbidden-mock",
        }),
      /Synthetic credits/,
    );
    const q = await core.createQuote(actor, {
      customerId: f.account.customer_id,
      beneficiaryId: "live-beneficiary",
      sourceCurrency: "USDT",
      sourceAmount: "10",
    });
    const order = (await core.createOrder(actor, {
      quoteId: q.id,
      clientOrderId: "live-order-test",
      fundingSource: "wallet",
    })) as any;
    await core.confirmManualPayout(
      { id: "isolated-admin", role: "merchant_admin" },
      order.id,
      {
        idempotencyKey: "provider-payment-test",
        outcome: "sent",
        actualAmount: order.quote.payoutAmount,
        paidAt: new Date(f.now()).toISOString(),
        providerReference: "synthetic-bank-reference",
        evidence: "isolated provider attestation test",
      },
    );
    const state = await f.store.read();
    assert.ok(
      state.journals.every((j) =>
        j.lines.every((l) => !l.account.includes(":mock")),
      ),
    );
    assert.ok(
      state.journals.some((j) =>
        j.lines.some((l) =>
          l.account.startsWith("liability:provider-settlement:"),
        ),
      ),
    );
    assert.equal(
      state.journals.filter((j) =>
        j.lines.some((l) => l.account === "asset:treasury:nowpayments"),
      ).length,
      1,
    );
    assert.equal(state.orders[0].walletFundingStatus, "consumed");
    await bindFundsMode(f.auth, "live", false);
  } finally {
    await f.db.close();
  }
});

test("a slower stale provider GET cannot overwrite a newer credited observation", async () => {
  const f = await fixture();
  try {
    const p = await f.funding.create(f.account, request),
      waiting = { ...f.providerPayments.get("101") };
    let release!: () => void, started!: () => void;
    const slow = new Promise<void>((r) => (release = r)),
      ready = new Promise<void>((r) => (started = r));
    let calls = 0;
    f.funding.provider.get = async () => {
      if (++calls === 1) {
        started();
        await slow;
        return waiting;
      }
      return { ...waiting, payment_status: "finished", outcome_amount: 99 };
    };
    const first = f.funding.refresh({ id: p.id, provider_id: "101" });
    await ready;
    await f.funding.refresh({ id: p.id, provider_id: "101" });
    release();
    await first;
    assert.equal((await f.funding.list(f.account))[0].status, "credited");
    assert.equal((await f.store.read()).customers[0].status, "approved");
    assert.equal((await f.store.read()).journals.length, 1);
  } finally {
    await f.db.close();
  }
});

test("a new customer's self-chosen strong password does not require a redundant first-login reset", async () => {
  const f = await fixture();
  try {
    const user = await f.auth.register({
        email: "new-customer@example.com",
        password,
        name: "New customer",
        kind: "personal",
      }),
      login = await f.auth.login(
        { identifier: "new-customer@example.com", password },
        "new-customer",
      );
    const response = await f.app(
      new Request("https://workspace.example/workspace/api/wallet/funding", {
        headers: { cookie: "__Secure-offramp-workspace=" + login.token },
      }),
      "new-customer",
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).enabled, true);
    const account = await f.auth.current(login.token);
    assert.equal((await f.security.status(account)).passwordChanged, true);
  } finally {
    await f.db.close();
  }
});
