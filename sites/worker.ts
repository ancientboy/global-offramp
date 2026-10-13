/**
 * Private, synthetic-only Worker preview. This is a fetch adapter, not NestJS,
 * PostgreSQL, a durable ledger, an identity provider, or a payment integration.
 * Every browser cookie owns its own volatile, bounded instance of the real core.
 */
import { Buffer } from "buffer";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { ACTORS } from "../packages/core/src/fixtures";
import { DomainError, demand } from "../packages/core/src/money";
import { OfframpService } from "../packages/core/src/service";
import { authorize, signWebhook } from "../packages/core/src/security";
import { MemoryStore } from "../packages/core/src/store";
import type { Actor, State } from "../packages/core/src/types";

export interface PreviewEnvironment {
  ASSETS: { fetch(request: Request): Promise<Response> };
}
export const PREVIEW_LIMITS = Object.freeze({
  ttlMs: 30 * 60 * 1000,
  maxSessions: 16,
  maxStateBytes: 1024 * 1024,
  maxBodyBytes: 128 * 1024,
  requestsPerMinute: 120,
  commandsPerMinute: 40,
  globalRequestsPerMinute: 600,
  newSessionsPerMinute: 32,
  maxPendingPerSession: 8,
});
const COOKIE = "__Host-offramp-preview";
const MINUTE = 60_000;
const encoder = new TextEncoder();
const pathId = "([a-zA-Z0-9_-]{1,100})";
const seedSchema = z
  .object({
    idempotencyKey: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-zA-Z0-9_-]+$/),
  })
  .strict();
const scalarId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);

class PreviewError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(code: string, status: number, message: string): never {
  throw new PreviewError(code, status, message);
}
/** Runs the unmodified MemoryStore transaction, rejecting oversize drafts before commit. */
export class BoundedMemoryStore extends MemoryStore {
  constructor(private readonly byteLimit = PREVIEW_LIMITS.maxStateBytes) {
    super();
  }
  override transaction<T>(work: (s: State) => T | Promise<T>): Promise<T> {
    return super.transaction(async (draft) => {
      const value = await work(draft);
      if (encoder.encode(JSON.stringify(draft)).byteLength > this.byteLimit)
        fail(
          "SESSION_CAPACITY",
          413,
          "Synthetic session storage is full. Start a fresh preview session.",
        );
      return value;
    });
  }
}
interface Bucket {
  start: number;
  count: number;
}
function consume(bucket: Bucket, now: number, limit: number): void {
  if (now - bucket.start >= MINUTE) {
    bucket.start = now;
    bucket.count = 0;
  }
  if (bucket.count >= limit)
    fail(
      "RATE_LIMITED",
      429,
      "Preview request limit reached. Please wait a minute.",
    );
  bucket.count++;
}
interface Session {
  token: string;
  secret: string;
  createdAt: number;
  touchedAt: number;
  expiresAt: number;
  core: OfframpService;
  requests: Bucket;
  commands: Bucket;
  tail: Promise<void>;
  pending: number;
}
async function serial<T>(session: Session, work: () => Promise<T>): Promise<T> {
  if (session.pending >= PREVIEW_LIMITS.maxPendingPerSession)
    fail("SESSION_BUSY", 429, "Too many pending preview commands.");
  session.pending++;
  const previous = session.tail;
  let release!: () => void;
  session.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await work();
  } finally {
    session.pending--;
    release();
  }
}
function randomToken(): string {
  return Array.from(
    globalThis.crypto.getRandomValues(new Uint8Array(32)),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
}
function sessionCookie(request: Request): string | undefined {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(COOKIE + "="));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
function setCookie(session: Session): string {
  return `${COOKIE}=${session.token}; Path=/; Max-Age=${PREVIEW_LIMITS.ttlMs / 1000}; HttpOnly; Secure; SameSite=Strict`;
}
function json(value: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store, max-age=0",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "x-preview-mode": "MOCK",
    vary: "Cookie, x-demo-actor",
  });
  if (cookie) headers.set("set-cookie", cookie);
  if (status === 429) headers.set("retry-after", "60");
  return new Response(JSON.stringify(value), { status, headers });
}
function safeError(error: unknown): Response {
  if (error instanceof PreviewError)
    return json({ error: error.code, message: error.message }, error.status);
  if (error instanceof DomainError) {
    const status = ["FORBIDDEN", "MAKER_CHECKER", "WRONG_MAKER"].includes(
      error.code,
    )
      ? 403
      : error.code === "UNAUTHENTICATED"
        ? 401
        : error.code === "NOT_FOUND"
          ? 404
          : 409;
    // Core domain messages are authored static explanations, not provider/server exceptions.
    return json({ error: error.code, message: error.message }, status);
  }
  if (error instanceof ZodError)
    return json(
      {
        error: "INVALID_INPUT",
        message: "Input does not match the mock command schema.",
      },
      400,
    );
  if (error instanceof SyntaxError)
    return json(
      { error: "INVALID_JSON", message: "A valid JSON object is required." },
      400,
    );
  return json(
    {
      error: "INTERNAL_ERROR",
      message: "The preview could not complete this request.",
    },
    500,
  );
}
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim();
  if (contentType !== "application/json")
    fail("CONTENT_TYPE", 415, "Use application/json for mock commands.");
  const declared = request.headers.get("content-length");
  if (
    declared &&
    (!/^\d+$/.test(declared) || Number(declared) > PREVIEW_LIMITS.maxBodyBytes)
  )
    fail("BODY_TOO_LARGE", 413, "Preview request exceeds 128 KiB.");
  if (!request.body) return {};
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + 5000;
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        fail("BODY_TIMEOUT", 408, "Preview request body timed out.");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new PreviewError(
                    "BODY_TIMEOUT",
                    408,
                    "Preview request body timed out.",
                  ),
                ),
              remaining,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const { done, value } = part;
      if (done) break;
      size += value.byteLength;
      if (size > PREVIEW_LIMITS.maxBodyBytes) {
        await reader.cancel();
        fail("BODY_TOO_LARGE", 413, "Preview request exceeds 128 KiB.");
      }
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (size === 0) return {};
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(joined),
    );
  } catch {
    fail("INVALID_JSON", 400, "A valid JSON object is required.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_INPUT", 400, "A JSON object is required.");
  return value as Record<string, unknown>;
}
async function mockDeposit(
  session: Session,
  actor: Actor,
  orderId: string,
  now: number,
) {
  authorize(actor, "mock.deposit");
  const order = (await session.core.store.read()).orders.find(
    (o) => o.id === orderId,
  );
  demand(order, "NOT_FOUND", "Order not found");
  const raw = Buffer.from(
    JSON.stringify({
      eventId: "demo-event-" + order.id,
      transactionId: "demo-transaction-" + order.id,
      orderId: order.id,
      currency: order.quote.sourceCurrency,
      amount: order.quote.totalDeposit,
      network: "MOCK",
      confirmations: 1,
    }),
  );
  const timestamp = Math.floor(now / 1000).toString();
  return session.core.receiveDeposit(
    raw,
    timestamp,
    signWebhook(raw, timestamp, session.secret),
    session.secret,
  );
}
/** Bounded fixture orchestration through the same public core methods, never process.env. */
async function seedScenario(
  session: Session,
  actor: Actor,
  input: unknown,
  now: () => number,
) {
  authorize(actor, "mock.seed");
  const { idempotencyKey } = seedSchema.parse(input);
  const core = session.core;
  const key = "demo-scenario:" + idempotencyKey;
  const existing = (await core.store.read()).outbox.find(
    (e) => e.topic === "demo.scenario.created" && e.aggregateId === key,
  );
  if (existing)
    return {
      mode: "MOCK",
      fixtureOnly: true,
      orderIds: existing.payload.orderIds,
    };
  const results: string[] = [];
  const specs = [
    {
      label: "funded",
      sourceAmount: "1000",
      sourceCurrency: "USDT",
      beneficiaryId: "beneficiary-cn",
    },
    {
      label: "approved",
      sourceAmount: "2500",
      sourceCurrency: "USDC",
      beneficiaryId: "beneficiary-us",
    },
    {
      label: "reconciled",
      sourceAmount: "500",
      sourceCurrency: "USDT",
      beneficiaryId: "beneficiary-cn",
    },
  ] as const;
  for (const spec of specs) {
    const clientOrderId = idempotencyKey + "_" + spec.label;
    let order = (await core.store.read()).orders.find(
      (o) => o.clientOrderId === clientOrderId && o.customerId === "customer-1",
    );
    if (!order) {
      const quote = await core.createQuote(actor, {
        customerId: "customer-1",
        beneficiaryId: spec.beneficiaryId,
        sourceCurrency: spec.sourceCurrency,
        sourceAmount: spec.sourceAmount,
        amountMode: "principal",
      });
      await core.createOrder(actor, { quoteId: quote.id, clientOrderId });
      order = (await core.store.read()).orders.find(
        (o) =>
          o.clientOrderId === clientOrderId && o.customerId === "customer-1",
      )!;
    }
    if (order.depositStatus === "awaiting")
      await mockDeposit(session, actor, order.id, now());
    if (spec.label !== "funded") {
      order = (await core.store.read()).orders.find((o) => o.id === order!.id)!;
      if (order.conversionStatus === "pending")
        await core.recordConversion(ACTORS["checker-demo"], order.id, {
          providerReference: "demo-fx-" + order.id,
          actualRate: order.quote.customerRate,
          evidence:
            "MOCK fixture: synthetic allocation record; no conversion occurred",
        });
      let attempt = (await core.store.read()).attempts.find(
        (a) => a.orderId === order!.id,
      );
      if (!attempt)
        attempt = await core.preparePayout(
          ACTORS["maker-demo"],
          order.id,
          "demo-pay-" + order.id,
        );
      if (attempt.state === "awaiting_approval")
        await core.approvePayout(ACTORS["checker-demo"], attempt.id);
      if (spec.label === "reconciled") {
        attempt = (await core.store.read()).attempts.find(
          (a) => a.id === attempt!.id,
        )!;
        if (attempt.state === "approved")
          await core.recordPayout(ACTORS["maker-demo"], attempt.id, {
            outcome: "sent",
            providerReference: "demo-provider-" + order.id,
            evidence: "MOCK fixture: simulated portal success; no money sent",
          });
        order = (await core.store.read()).orders.find(
          (o) => o.id === order!.id,
        )!;
        if (order.payoutStatus === "sent" && !order.reconciled)
          await core.reconcile(ACTORS["checker-demo"], order.id, {
            providerReference: "demo-provider-" + order.id,
            actualAmount: order.quote.payoutAmount,
            evidence: "MOCK fixture: simulated independent statement match",
          });
      }
    }
    results.push(order.id);
  }
  await core.store.transaction((s) => {
    const at = new Date(now()).toISOString();
    s.outbox.push({
      id: randomUUID(),
      topic: "demo.scenario.created",
      aggregateId: key,
      payload: { orderIds: results, fixtureOnly: true },
      createdAt: at,
    });
    s.audits.push({
      id: randomUUID(),
      actorId: actor.id,
      action: "demo.scenario.created",
      targetId: key,
      data: { orderCount: results.length, fixtureOnly: true },
      at,
    });
  });
  return { mode: "MOCK", fixtureOnly: true, orderIds: results };
}

type Command = (
  s: Session,
  a: Actor,
  b: Record<string, unknown>,
  id: string,
  now: () => number,
) => Promise<unknown>;
interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  run: Command;
}
const route = (
  method: Route["method"],
  pattern: string,
  run: Command,
): Route => ({ method, pattern: new RegExp("^/api/" + pattern + "$"), run });
// Deliberate allowlist. There is no dynamic service-method invocation and no external webhook route.
const ROUTES: Route[] = [
  route("GET", "dashboard", (s, a) => s.core.dashboard(a)),
  route("GET", "audit", (s, a) => s.core.auditTrail(a)),
  route("POST", "demo/reset", async (s, a, b, _id, now) => {
    authorize(a, "mock.seed");
    z.object({ confirm: z.literal("reset-synthetic-session") })
      .strict()
      .parse(b);
    // Explicitly discards only this browser's disposable synthetic domain state.
    // Keep the fixed session expiry and rate counters; reset cannot extend either.
    s.core = new OfframpService(
      new BoundedMemoryStore(),
      () => new Date(now()),
    );
    s.secret = randomToken();
    return {
      mode: "MOCK",
      fixtureOnly: true,
      reset: true,
      scope: "current-session",
    };
  }),
  route("POST", "demo/scenario", (s, a, b, _id, now) =>
    seedScenario(s, a, b, now),
  ),
  route("POST", `demo/orders/${pathId}/deposit`, (s, a, _b, id, now) =>
    mockDeposit(s, a, id, now()),
  ),
  route("POST", "customers", (s, a, b) => s.core.createCustomer(a, b)),
  route("POST", `customers/${pathId}/review`, (s, a, b, id) =>
    s.core.reviewCustomer(
      a,
      id,
      z.enum(["approved", "suspended"]).parse(b.status),
    ),
  ),
  route("POST", "beneficiaries", (s, a, b) => s.core.createBeneficiary(a, b)),
  route("POST", `beneficiaries/${pathId}/approve`, (s, a, _b, id) =>
    s.core.approveBeneficiary(a, id),
  ),
  route("POST", "quotes", (s, a, b) => s.core.createQuote(a, b)),
  route("POST", "orders", (s, a, b) => s.core.createOrder(a, b)),
  route("POST", `orders/${pathId}/conversion`, (s, a, b, id) =>
    s.core.recordConversion(a, id, b),
  ),
  route("POST", `orders/${pathId}/attempts`, (s, a, b, id) =>
    s.core.preparePayout(a, id, scalarId.parse(b.idempotencyKey)),
  ),
  route("POST", `attempts/${pathId}/approve`, (s, a, _b, id) =>
    s.core.approvePayout(a, id),
  ),
  route("POST", `attempts/${pathId}/record`, (s, a, b, id) =>
    s.core.recordPayout(a, id, b),
  ),
  route("POST", `attempts/${pathId}/resolve`, (s, a, b, id) =>
    s.core.resolvePayout(a, id, b),
  ),
  route("POST", `orders/${pathId}/receipt-metadata`, (s, a, b, id) =>
    s.core.uploadReceipt(a, id, z.string().max(250).parse(b.objectKey)),
  ),
  route("POST", `orders/${pathId}/reconcile`, (s, a, b, id) =>
    s.core.reconcile(a, id, b),
  ),
  route("POST", `discrepancies/${pathId}/resolve`, (s, a, b, id) =>
    s.core.resolveDiscrepancy(a, id, z.string().max(500).parse(b.evidence)),
  ),
  route("POST", `orders/${pathId}/refunds`, (s, a, b, id) =>
    s.core.requestRefund(a, id, b),
  ),
  route("POST", `refunds/${pathId}/approve`, (s, a, _b, id) =>
    s.core.approveRefund(a, id),
  ),
  route("POST", `refunds/${pathId}/record`, (s, a, b, id) =>
    s.core.recordRefund(a, id, b),
  ),
  route("POST", "settlements", (s, a, b) => s.core.createSettlement(a, b)),
  route("POST", `settlements/${pathId}/approve`, (s, a, _b, id) =>
    s.core.approveSettlement(a, id),
  ),
  route("POST", `settlements/${pathId}/cancel`, (s, a, b, id) =>
    s.core.cancelSettlement(a, id, z.string().max(500).parse(b.reason)),
  ),
  route("POST", "batches", (s, a, b) =>
    s.core.importBatch(
      a,
      scalarId.parse(b.customerId),
      scalarId.parse(b.clientBatchId),
      z.string().max(100_000).parse(b.csv),
    ),
  ),
  route("POST", `batches/${pathId}/submit`, (s, a, _b, id) =>
    s.core.submitBatch(a, id),
  ),
];

/** now is injectable only for tests; no environment or HTTP setting can enable real execution. */
export function createPreviewWorker(options: { now?: () => number } = {}) {
  const now = options.now ?? (() => Date.now());
  const sessions = new Map<string, Session>();
  const globalRequests: Bucket = { start: now(), count: 0 };
  const newSessions: Bucket = { start: now(), count: 0 };
  function clean(at: number): void {
    for (const [token, session] of sessions)
      if (session.expiresAt <= at && session.pending === 0)
        sessions.delete(token);
  }
  function startSession(at: number): Session {
    consume(newSessions, at, PREVIEW_LIMITS.newSessionsPerMinute);
    if (sessions.size >= PREVIEW_LIMITS.maxSessions) {
      // Only synthetic, idle preview state can be evicted. No external/durable data exists.
      const oldest = Array.from(sessions.values())
        .filter((s) => s.pending === 0)
        .sort((a, b) => a.touchedAt - b.touchedAt)[0];
      if (!oldest)
        fail(
          "PREVIEW_BUSY",
          503,
          "All preview sessions are busy. Please try again.",
        );
      sessions.delete(oldest.token);
    }
    const session: Session = {
      token: randomToken(),
      secret: randomToken(),
      createdAt: at,
      touchedAt: at,
      expiresAt: at + PREVIEW_LIMITS.ttlMs,
      core: new OfframpService(new BoundedMemoryStore(), () => new Date(now())),
      requests: { start: at, count: 0 },
      commands: { start: at, count: 0 },
      tail: Promise.resolve(),
      pending: 0,
    };
    sessions.set(session.token, session);
    return session;
  }
  return {
    async fetch(request: Request, env: PreviewEnvironment): Promise<Response> {
      try {
        const url = new URL(request.url);
        if (url.pathname !== "/api" && !url.pathname.startsWith("/api/"))
          return await env.ASSETS.fetch(request);
        const at = now();
        clean(at);
        consume(globalRequests, at, PREVIEW_LIMITS.globalRequestsPerMinute);
        if (request.method === "GET" && url.pathname === "/api/health")
          return json({
            status: "ok",
            mode: "MOCK",
            realExecutionEnabled: false,
            persistence: "session-memory",
            volatile: true,
            ttlSeconds: PREVIEW_LIMITS.ttlMs / 1000,
            sessionScope: "browser-cookie, per Worker isolate",
            syntheticOnly: true,
            note: "Synthetic state may disappear on expiry, eviction, deployment, or Worker restart. No durable storage or provider execution.",
          });
        if (url.protocol !== "https:")
          fail("HTTPS_REQUIRED", 400, "The hosted preview requires HTTPS.");
        const fetchSite = request.headers.get("sec-fetch-site");
        if (fetchSite && fetchSite !== "same-origin")
          fail(
            "ORIGIN_REJECTED",
            403,
            "Only same-origin preview API requests are allowed.",
          );
        if (
          request.method !== "GET" &&
          request.headers.get("origin") !== url.origin
        )
          fail(
            "ORIGIN_REJECTED",
            403,
            "Mock commands require the same-origin Origin header.",
          );
        const matching = ROUTES.find(
          (r) => r.method === request.method && r.pattern.test(url.pathname),
        );
        if (!matching)
          return json(
            { error: "NOT_FOUND", message: "Unknown preview API route." },
            404,
          );
        const actorKey = request.headers.get("x-demo-actor") ?? "";
        if (!Object.prototype.hasOwnProperty.call(ACTORS, actorKey))
          fail("UNAUTHENTICATED", 401, "Select a known demo fixture actor.");
        const actor = ACTORS[actorKey];
        const token = sessionCookie(request);
        let session = token ? sessions.get(token) : undefined;
        if (session && session.expiresAt <= at) session = undefined;
        let cookie: string | undefined;
        if (!session) {
          if (request.method !== "GET" || url.pathname !== "/api/dashboard")
            fail(
              "SESSION_EXPIRED",
              410,
              "Preview session is missing or expired. Reload the dashboard to start a fresh synthetic session.",
            );
          session = startSession(at);
          cookie = setCookie(session);
        }
        consume(session.requests, at, PREVIEW_LIMITS.requestsPerMinute);
        session.touchedAt = at;
        const isCommand = request.method === "POST";
        if (isCommand)
          consume(session.commands, at, PREVIEW_LIMITS.commandsPerMinute);
        const id = matching.pattern.exec(url.pathname)?.[1] ?? "";
        // Serializing complete requests preserves seed idempotence and limits queued work.
        const value = await serial(session, async () => {
          if (session!.expiresAt <= now())
            fail(
              "SESSION_EXPIRED",
              410,
              "Preview session expired before this command started.",
            );
          const body = isCommand ? await readBody(request) : {};
          if (session!.expiresAt <= now())
            fail(
              "SESSION_EXPIRED",
              410,
              "Preview session expired while reading this command.",
            );
          return matching.run(session!, actor, body, id, now);
        });
        return json(value, 200, cookie);
      } catch (error) {
        return safeError(error);
      }
    },
  };
}
