import test from "node:test";
import assert from "node:assert/strict";
import {scryptSync,randomUUID} from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresStore, SqlPool } from "../../../packages/core/src/store";
import { fixtureState } from "../../../packages/core/src/fixtures";
import { Auth, digest } from "../src/auth";
import { workspaceApp, COOKIE } from "../src/app";
import { PrivateFiles } from "../src/files";
import { initializeWorkspace } from "../src/database";
const origin = "https://workspace.example";
const password = "test-only-long-password-42";
const migrations = [
  "db-runtime.sql",
  "db/migrations/002_workspace.sql",
  "db/migrations/003_route_drafts.sql",
  "db/migrations/004_operator_customer_username.sql",
].map((p) => readFileSync(p, "utf8"));
function poolFor(db: PGlite): SqlPool {
  return {
    query: (s, p) => db.query(s, p),
    connect: async () => ({ query: (s, p) => db.query(s, p) }),
  };
}
async function fixture(path?: string) {
  const db = new PGlite(path);
  for (const sql of migrations) await db.exec(sql);
  const pool = poolFor(db),
    store = new PostgresStore(pool);
  const empty = fixtureState();
  empty.customers = [];
  empty.beneficiaries = [];
  await store.initialize(empty);
  let now = Date.now();
  const auth = new Auth(pool, store, () => now);
  const dir = await mkdtemp(join(tmpdir(), "offramp-files-"));
  const bucket = new PrivateFiles(dir),
    app = workspaceApp(auth, bucket, origin);
  async function call(
    path: string,
    body?: unknown,
    cookie?: string,
    extra: Record<string, string> = {},
    ip = "192.0.2.1",
  ) {
    return app(
      new Request(origin + "/workspace/api/" + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin,
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      ip,
    );
  }
  async function register(email: string, kind = "personal") {
    const r = await call(
      "auth/register",
      { email, password, name: email.split("@")[0], kind },
      undefined,
      {},
      email,
    );
    assert.equal(r.status, 201, await r.clone().text());
    return (await r.json()).account;
  }
  async function login(email: string) {
    const r = await call(
      "auth/login",
      { identifier: email, password },
      undefined,
      {},
      email,
    );
    assert.equal(r.status, 200, await r.clone().text());
    return r.headers.get("set-cookie")!.split(";")[0];
  }
  return {
    db,
    pool,
    store,
    auth,
    bucket,
    call,
    register,
    login,
    advance: (ms: number) => {
      now += ms;
    },
    close: async () => {
      if (!db.closed) await db.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("account API rejects escalation/invalid names; duplicate and failed enrollments roll back; only hashes persist", async () => {
  const f = await fixture();
  try {
    for (const extra of [
      { role: "merchant_admin" },
      { customerId: "customer-1" },
      { name: "\u0000" },
      { email: "bad" },
    ]) {
      const r = await f.call("auth/register", {
        email: "a@example.com",
        password,
        name: "Alice",
        kind: "personal",
        ...extra,
      });
      assert.equal(r.status, 400);
    }
    const a = await f.register("Alice@Example.com");
    assert.equal(a.role, "customer");
    assert.notEqual(a.customerId, "customer-1");
    assert.equal(a.email, "alice@example.com");
    const duplicate = await f.call(
      "auth/register",
      {
        email: "ALICE@example.com",
        password,
        name: "Another",
        kind: "company",
      },
      undefined,
      {},
      "duplicate",
    );
    assert.equal(duplicate.status, 409);
    assert.equal((await f.store.read()).customers.length, 1);
    assert.equal(
      (await f.db.query("SELECT * FROM workspace.customers")).rows.length,
      1,
    );
    const before = await f.store.read();
    // Fail after both account inserts but before aggregate commit; no orphan identity survives.
    const failing: SqlPool = {
      query: f.pool.query,
      connect: async () => {
        const c = await f.pool.connect();
        return {
          query: (sql, args) => {
            if (sql.startsWith("UPDATE runtime.state"))
              throw new Error("injected commit failure");
            return c.query(sql, args);
          },
        };
      },
    };
    await assert.rejects(() =>
      new Auth(failing, new PostgresStore(failing)).register({
        email: "rollback@example.com",
        password,
        name: "Rollback",
        kind: "personal",
      }),
    );
    assert.deepEqual(await f.store.read(), before);
    assert.equal(
      (
        await f.db.query(
          "SELECT * FROM workspace.accounts WHERE email='rollback@example.com'",
        )
      ).rows.length,
      0,
    );
    const row = (
      await f.db.query<{ password_hash: string }>(
        "SELECT password_hash FROM workspace.accounts",
      )
    ).rows[0];
    assert.match(row.password_hash, /^scrypt-v1\$/);
    assert.ok(!row.password_hash.includes(password));
    const cookie = await f.login(a.email);
    const raw = cookie.split("=")[1];
    const sessions = await f.db.query<{ token_hash: string }>(
      "SELECT token_hash FROM workspace.sessions",
    );
    assert.equal(sessions.rows[0].token_hash, digest(raw));
    assert.notEqual(sessions.rows[0].token_hash, raw);
    await assert.rejects(
      () => f.db.query("DELETE FROM workspace.auth_audit"),
      /append-only/,
    );
  } finally {
    await f.close();
  }
});
test("login, logout, absolute expiry, revocation, disabled accounts, CSRF and persisted rate limits", async () => {
  const f = await fixture();
  try {
    await f.register("session@example.com");
    const wrong = await f.call("auth/login", {
      email: "session@example.com",
      password: "wrong-but-long-password",
    });
    assert.equal(wrong.status, 401);
    const r = await f.call("auth/login", {
      email: "session@example.com",
      password,
    });
    assert.equal(r.status, 200);
    const header = r.headers.get("set-cookie")!;
    for (const flag of [
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Path=/workspace/api",
      "Max-Age=28800",
    ])
      assert.ok(header.includes(flag));
    const c = header.split(";")[0];
    assert.equal((await f.call("auth/me", undefined, c)).status, 200);
    for (const headers of [
      { origin: "https://evil.example" },
      { origin: "" },
      { "sec-fetch-site": "cross-site" },
    ] as Record<string, string>[])
      assert.equal((await f.call("auth/logout", {}, c, headers)).status, 403);
    assert.equal(
      (
        await f.call("auth/me", undefined, c, {
          "sec-fetch-site": "cross-site",
        })
      ).status,
      403,
    );
    assert.equal((await f.call("auth/logout", {}, c)).status, 200);
    assert.equal((await f.call("auth/me", undefined, c)).status, 401);
    const expiring = await f.login("session@example.com");
    f.advance(8 * 60 * 60_000 + 1);
    assert.equal((await f.call("auth/me", undefined, expiring)).status, 401);
    const revoked = await f.login("session@example.com");
    await f.db.query("UPDATE workspace.sessions SET revoked_at=now()");
    assert.equal((await f.call("auth/me", undefined, revoked)).status, 401);
    const disabled = await f.login("session@example.com");
    await f.db.query("UPDATE workspace.accounts SET enabled=false");
    assert.equal((await f.call("auth/me", undefined, disabled)).status, 401);
    await f.db.query("UPDATE workspace.accounts SET enabled=true");
    for (let i = 0; i < 10; i++)
      assert.equal(
        (
          await f.call(
            "auth/login",
            { email: "brute@example.com", password: "invalid-password-42" },
            undefined,
            {},
            "198.51.100." + i,
          )
        ).status,
        401,
      );
    // New Auth object (process restart analogue) still observes shared SQL rate state.
    const fresh = workspaceApp(
      new Auth(f.pool, f.store, f.auth.now),
      f.bucket,
      origin,
    );
    const locked = await fresh(
      new Request(origin + "/workspace/api/auth/login", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email: "brute@example.com", password }),
      }),
      "new-ip",
    );
    assert.equal(locked.status, 429);
    assert.equal(
      (await f.call("auth/me", undefined, `${COOKIE}=bad`)).status,
      401,
    );
    assert.equal(
      (await f.call("auth/me", undefined, c + "; " + c)).status,
      401,
    );
  } finally {
    await f.close();
  }
});
test("service binds identity, enforces tenant/admin isolation and serves only explicitly published receipts", async () => {
  const f = await fixture();
  try {
    const a = await f.register("a@example.com"),
      b = await f.register("b@example.com", "company");
    const ac = await f.login(a.email),
      bc = await f.login(b.email);
    await f.auth.createAdmin(
      { username: "operations", password },
      "Sandbox admin",
    );
    const admin = await f.login("operations");
    assert.equal(
      (
        await f.call("dashboard", undefined, undefined, {
          "x-demo-actor": "admin-demo",
          "oai-authenticated-user-id": "admin",
        })
      ).status,
      401,
    );
    const forged = await f.call("dashboard", undefined, ac, {
      "x-demo-actor": "admin-demo",
      "x-customer-id": b.customerId,
    });
    assert.equal(forged.status, 200);
    const own = await forged.json();
    assert.equal(own.actor.role, "customer");
    assert.deepEqual(
      own.customers.map((c: any) => c.id),
      [a.customerId],
    );
    assert.equal(own.customers[0].status, "pending");
    assert.equal((await f.call("audit", undefined, ac)).status, 403);
    assert.equal((await f.call("receipts", undefined, ac)).status, 403);
    assert.equal(
      (
        await f.call(
          `customers/${b.customerId}/review`,
          { status: "approved" },
          ac,
        )
      ).status,
      403,
    );
    const dash = await (await f.call("dashboard", undefined, admin)).json();
    assert.equal(dash.customers.length, 2);
    for (const customer of [a, b])
      assert.equal(
        (
          await f.call(
            `customers/${customer.customerId}/review`,
            { status: "approved" },
            admin,
          )
        ).status,
        200,
      );
    const spec = {
      customerId: a.customerId,
      name: "Alice recipient",
      country: "US",
      currency: "USD",
      accountToken: "sandbox-token",
      accountMasked: "**** 1234",
    };
    assert.equal(
      (await f.call("beneficiaries", { ...spec, customerId: b.customerId }, ac))
        .status,
      403,
    );
    const recipient = await f.call("beneficiaries", spec, ac);
    assert.equal(recipient.status, 200);
    const beneficiary = await recipient.json();
    assert.equal(
      (
        await f.call(
          "quotes",
          {
            customerId: a.customerId,
            beneficiaryId: beneficiary.id,
            sourceCurrency: "USDT",
            sourceAmount: "100",
          },
          bc,
        )
      ).status,
      403,
    );
    const q = await f.call(
      "quotes",
      {
        customerId: a.customerId,
        beneficiaryId: beneficiary.id,
        sourceCurrency: "USDT",
        sourceAmount: "100",
      },
      ac,
    );
    assert.equal(q.status, 200);
    const quote = await q.json();
    assert.equal(
      (
        await f.call(
          "orders",
          { quoteId: quote.id, clientOrderId: "stolen-quote" },
          bc,
        )
      ).status,
      403,
    );
    const or = await f.call(
      "orders",
      { quoteId: quote.id, clientOrderId: "sandbox-order" },
      ac,
    );
    assert.equal(or.status, 200);
    const order = await or.json();
    assert.equal(
      (
        await f.call(
          `orders/${order.id}/cancel`,
          { reason: "cross-tenant attack" },
          bc,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.call(`orders/${order.id}/published-receipts`, undefined, bc))
        .status,
      403,
    );
    assert.equal(
      (await f.call(`orders/${order.id}/receipt-file`, undefined, bc)).status,
      403,
    );
    for (const who of [ac, admin])
      for (const path of [
        "demo/scenario",
        "demo/reset",
        `demo/orders/${order.id}/deposit`,
        "wallet/deposits",
        `orders/${order.id}/mock-payout`,
        `orders/${order.id}/manual-payout`,
        `orders/${order.id}/complete-recorded-payment`,
      ])
        assert.equal((await f.call(path, {}, who)).status, 403, path);
    const bytes = Buffer.from("%PDF-1.4\nsynthetic redacted receipt\n%%EOF");
    const upload = await f.call(
      "receipts/upload",
      {
        kind: "single",
        files: [
          {
            fileName: "redacted.pdf",
            contentType: "application/pdf",
            dataBase64: bytes.toString("base64"),
          },
        ],
      },
      admin,
    );
    assert.equal(upload.status, 200, await upload.clone().text());
    const receipt = (await upload.json()).receipts[0];
    assert.equal(
      (await f.call(`receipts/${receipt.id}/download`, undefined, ac)).status,
      403,
    );
    assert.equal(
      (await f.call(`published-receipts/${receipt.id}/download`, undefined, ac))
        .status,
      404,
    );
    // Historical failed sandbox order fixture: public workspace APIs cannot mark payment results.
    await f.store.transaction((s) => {
      s.orders.find((o) => o.id === order.id)!.payoutStatus = "failed";
    });
    const link = await f.call(
      `receipts/${receipt.id}/link`,
      {
        orderId: order.id,
        reason: "Manually verified sandbox receipt",
        confirmed: true,
      },
      admin,
    );
    assert.equal(link.status, 200, await link.clone().text());
    assert.equal(
      (
        await f.call(
          `receipts/${receipt.id}/publish`,
          {
            orderId: order.id,
            confirmedSingleCustomer: true,
            confirmedRedacted: true,
            purpose: "sandbox customer copy",
          },
          admin,
        )
      ).status,
      200,
    );
    const download = await f.call(
      `published-receipts/${receipt.id}/download`,
      undefined,
      ac,
    );
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.match(download.headers.get("cache-control")!, /no-store/);
    assert.equal(
      (await f.call(`published-receipts/${receipt.id}/download`, undefined, bc))
        .status,
      403,
    );
    assert.equal(
      (await f.call(`receipts/${receipt.id}/download`, undefined, bc)).status,
      403,
    );
    const bDash = await (await f.call("dashboard", undefined, bc)).json();
    assert.equal(bDash.orders.length, 0);
    assert.equal(bDash.beneficiaries.length, 0);
    assert.equal((await f.store.read()).orders[0].depositStatus, "awaiting");
    assert.equal((await f.store.read()).journals.length, 0);
    const response = JSON.stringify(
      await (await f.call("auth/me", undefined, admin)).json(),
    );
    assert.ok(!/password|token_hash|scrypt/.test(response));
    await assert.rejects(() => f.bucket.get("../../secret"));
  } finally {
    await f.close();
  }
});
test("PostgreSQL SQL adapter survives a physical PGlite close/reopen with account, session and business customer intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "offramp-pg-"));
  const path = join(dir, "database");
  const f = await fixture(path);
  try {
    const a = await f.register("restart@example.com");
    const cookie = await f.login(a.email);
    await f.db.close();
    const db = new PGlite(path);
    try {
      const store = new PostgresStore(poolFor(db)),
        auth = new Auth(poolFor(db), store);
      const app = workspaceApp(auth, f.bucket, origin);
      const r = await app(
        new Request(origin + "/workspace/api/dashboard", {
          headers: { cookie },
        }),
        "restart",
      );
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.customers[0].id, a.customerId);
      assert.equal(
        (
          await db.query(
            "SELECT * FROM workspace.auth_audit WHERE action='login.succeeded'",
          )
        ).rows.length,
        1,
      );
      await assert.rejects(
        () =>
          store.transaction((s) => {
            s.audits = [];
          }),
        /cannot be deleted/,
      );
    } finally {
      await db.close();
    }
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test("configured non-owner SQL role can run account transactions but cannot rewrite ledger, audit or session identity", async () => {
  const f = await fixture();
  try {
    await f.db.exec("CREATE ROLE workspace_app_test");
    const grants = readFileSync(
      "deploy/workspace/grants.sql",
      "utf8",
    ).replaceAll(':"app_role"', "workspace_app_test");
    await f.db.exec(grants);
    await f.db.exec("SET ROLE workspace_app_test");
    await f.register("role@example.com");
    const c = await f.login("role@example.com");
    assert.equal((await f.call("dashboard", undefined, c)).status, 200);
    assert.equal((await f.call("auth/logout", {}, c)).status, 200);
    for (const sql of [
      "DELETE FROM runtime.audit",
      "UPDATE runtime.audit SET action='forged'",
      "TRUNCATE runtime.ledger_lines",
      "UPDATE runtime.ledger_lines SET debit=1",
      "UPDATE workspace.sessions SET expires_at=now()+interval '1 year'",
      "UPDATE workspace.accounts SET role='merchant_admin'",
      "UPDATE workspace.accounts SET enabled=false",
      "DELETE FROM workspace.auth_audit",
      "DROP TABLE workspace.accounts",
      "INSERT INTO runtime.journals(id,business_key,created_at,created_tx) VALUES(gen_random_uuid(),'forged',now(),1)",
    ])
      await assert.rejects(
        () => f.db.exec(sql),
        /permission denied|must be owner/,
      );
  } finally {
    await f.db.exec("RESET ROLE");
    await f.close();
  }
});

test("workspace startup fails closed on an accidentally selected demo aggregate", async () => {
  const f = await fixture();
  try {
    await initializeWorkspace(f.pool);
    await f.store.transaction((s) => {
      s.customers.push(fixtureState().customers[0]);
    });
    await assert.rejects(
      () => initializeWorkspace(f.pool),
      /unbound legacy\/demo/,
    );
  } finally {
    await f.close();
  }
});

test("administrator uses a username without an email; clients cannot self-register a username or staff role", async () => {
  const f = await fixture();
  try {
    await f.auth.createAdmin({ username: "Ops_Admin", password }, "Operations");
    const row = (
      await f.db.query<{ email: null; username: string }>(
        "SELECT email,username FROM workspace.accounts",
      )
    ).rows[0];
    assert.equal(row.email, null);
    assert.equal(row.username, "ops_admin");
    const cookie = await f.login("OPS_ADMIN");
    const me = await (await f.call("auth/me", undefined, cookie)).json();
    assert.equal(me.account.role, "merchant_admin");
    assert.equal(me.account.username, "ops_admin");
    assert.equal(me.account.email, null);
    assert.equal(
      (
        await f.call("auth/register", {
          email: "escalation@example.com",
          name: "User",
          kind: "personal",
          password,
          username: "other_admin",
        })
      ).status,
      400,
    );
    await assert.rejects(() =>
      f.auth.createAdmin(
        { username: "invalid@domain.com", password },
        "Invalid",
      ),
    );
  } finally {
    await f.close();
  }
});

test("login accepts an operator-set short existing password while customer registration keeps its creation policy", async () => {
  const f = await fixture();
  try {
    await f.auth.createAdmin({username:"short_login",password},"Operator");
    const salt="0123456789abcdef0123456789abcdef";
    const stored="scrypt-v1$"+salt+"$"+scryptSync("test123",salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString("hex");
    await f.db.query("UPDATE workspace.accounts SET password_hash=$1 WHERE username='short_login'",[stored]);
    const r=await f.call("auth/login",{identifier:"short_login",password:"test123"});
    assert.equal(r.status,200);
    assert.equal((await f.call("auth/login",{username:"short_login",password:"wrong12"})).status,401);
    assert.equal((await f.call("auth/register",{email:"short@example.com",name:"Client",kind:"personal",password:"test123"})).status,400);
    const cookie=r.headers.get("set-cookie")!.split(";")[0];
    assert.equal((await f.call("auth/logout",{},cookie)).status,200);
    assert.equal((await f.call("auth/me",undefined,cookie)).status,401);
  } finally {await f.close();}
});

test("operator-provisioned username customer can log in but cannot enter the admin scope", async () => {
  const f=await fixture();
  try {
    const customerId=randomUUID(),accountId=randomUUID(),at=new Date();
    const salt="0123456789abcdef0123456789abcdef";
    const stored="scrypt-v1$"+salt+"$"+scryptSync("test123",salt,32,{N:32768,r:8,p:1,maxmem:64*1024*1024}).toString("hex");
    await f.store.transactionWithClient(async(s,c)=>{
      await c.query("INSERT INTO workspace.customers(id,kind,created_at) VALUES($1,'personal',$2)",[customerId,at]);
      await c.query("INSERT INTO workspace.accounts(id,username,display_name,password_hash,role,customer_id,created_at) VALUES($1,'test_user','Customer',$2,'customer',$3,$4)",[accountId,stored,customerId,at]);
      s.customers.push({id:customerId,kind:"personal",name:"Customer",status:"pending"});
    });
    const login=await f.call("auth/login",{identifier:"test_user",password:"test123"});assert.equal(login.status,200);
    const cookie=login.headers.get("set-cookie")!.split(";")[0];
    const dashboard=await (await f.call("dashboard",undefined,cookie,{'x-demo-actor':'admin-demo'})).json();
    assert.equal(dashboard.actor.role,"customer");assert.deepEqual(dashboard.customers.map((c:any)=>c.id),[customerId]);
    assert.equal((await f.call("customers/"+customerId+"/review",{status:"approved"},cookie)).status,403);
    assert.equal((await f.call("audit",undefined,cookie)).status,403);
  } finally {await f.close();}
});

test("route drafts require admin, preserve optimistic versions and never enable money; recipient checks echo no account values", async () => {
  const f = await fixture();
  try {
    await f.register("route-client@example.com");
    const client = await f.login("route-client@example.com");
    await f.auth.createAdmin(
      { username: "route_admin", password },
      "Route admin",
    );
    const admin = await f.login("route_admin");
    const draft = {
      expectedVersion: 0,
      referenceRate: "0.90",
      serviceFee: "3.000000",
      channelFee: "1",
      minPayout: "10",
      maxPayout: "10000",
      providerName: "Sandbox operator",
      processingNote: "Manual records only",
    };
    assert.equal(
      (await f.call("routes/USDT-EUR/draft", draft, client)).status,
      403,
    );
    const saved = await f.call("routes/USDT-EUR/draft", draft, admin);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).realExecutionEnabled, false);
    assert.equal(
      (await f.call("routes/USDT-EUR/draft", draft, admin)).status,
      409,
    );
    assert.equal(
      (
        await f.call(
          "routes/USDT-EUR/draft",
          { ...draft, expectedVersion: 1, minPayout: "10001" },
          admin,
        )
      ).status,
      400,
    );
    const catalog = await (await f.call("routes", undefined, admin)).json();
    assert.equal(catalog.routes.length, 12);
    const row = catalog.routes.find((r: any) => r.id === "USDT-EUR");
    assert.equal(row.version, 1);
    assert.equal(row.status, "draft");
    assert.equal(row.channelStatus, "disabled");
    const customerCatalog = await (
      await f.call("routes", undefined, client)
    ).json();
    assert.ok(!JSON.stringify(customerCatalog).includes("Sandbox operator"));
    const result = await f.call(
      "routes/USDT-MXN/validate-recipient",
      {
        method: "MX_CLABE",
        fields: {
          accountHolderName: "PRIVATE_NAME",
          clabe: "002180032240946700",
        },
      },
      client,
    );
    assert.equal(result.status, 200);
    const text = await result.text();
    assert.ok(!text.includes("PRIVATE_NAME"));
    assert.ok(!text.includes("002180032240946700"));
    assert.equal(JSON.parse(text).payable, false);
    assert.equal(
      (
        await f.call(
          "routes/USDT-MXN/validate-recipient",
          { method: "GB_IBAN", fields: {} },
          client,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(
          "routes/USDT-MXN/draft",
          { ...draft, enabled: true },
          admin,
        )
      ).status,
      400,
    );
    const audits = await f.db.query(
      "SELECT * FROM workspace.auth_audit WHERE action='route.draft.saved'",
    );
    assert.equal(audits.rows.length, 1);
  } finally {
    await f.close();
  }
});
