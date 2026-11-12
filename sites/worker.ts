/**
 * Private, synthetic-only Worker preview. This is a fetch adapter, not NestJS,
 * PostgreSQL, a durable ledger, an identity provider, or a payment integration.
 * D1 keeps bounded synthetic history per authenticated Site visitor when bound.
 * Cookies only hold request controls; no DB means disposable local preview mode.
 */
import { referencePricing } from "../packages/core/src/market-reference";
import { D1MockStore, D1_MAX_STATE_BYTES, type D1Database } from "./d1-store";
import { Buffer } from "buffer";
import { createHash, randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import { ACTORS } from "../packages/core/src/fixtures";
import { DomainError, demand } from "../packages/core/src/money";
import { OfframpService } from "../packages/core/src/service";
import { authorize, signWebhook } from "../packages/core/src/security";
import { MemoryStore } from "../packages/core/src/store";
import type { Actor, State } from "../packages/core/src/types";

import {
  validateReceiptFile,
  requireReceiptAdmin,
  RECEIPT_MAX_BYTES,
} from "../packages/core/src/receipts";
export interface ReceiptBucket {
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}
export interface PreviewEnvironment {
  MARKET_RATES?: { fetch(request: Request): Promise<Response> };
  BUCKET?: ReceiptBucket;
  DB?: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
}
export const PREVIEW_LIMITS = Object.freeze({
  ttlMs: 30 * 60 * 1000,
  maxSessions: 4,
  maxStateBytes: 4 * 1024 * 1024,
  maxBodyBytes: 3 * 1024 * 1024,
  requestsPerMinute: 120,
  commandsPerMinute: 40,
  globalRequestsPerMinute: 600,
  newSessionsPerMinute: 32,
  maxPendingPerSession: 8,
});
export const DURABLE_RECEIPT_MAX_BYTES = 256 * 1024;
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
  workspace?: boolean;
  owner?: string;
  receiptBucket?: ReceiptBucket;
  receiptBlobs: Map<string, Uint8Array>;
  durable: boolean;
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
    vary: "Cookie, x-demo-actor, oai-authenticated-user-id",
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
    fail("BODY_TOO_LARGE", 413, "Preview request exceeds 3 MiB.");
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
        fail("BODY_TOO_LARGE", 413, "Preview request exceeds 3 MiB.");
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
          providerReference: "MOCK-FX-" + order.id,
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
            providerReference: "MOCK-PAYOUT-" + order.id,
            evidence: "MOCK fixture: simulated portal success; no money sent",
          });
        order = (await core.store.read()).orders.find(
          (o) => o.id === order!.id,
        )!;
        if (order.payoutStatus === "sent" && !order.reconciled)
          await core.reconcile(ACTORS["checker-demo"], order.id, {
            providerReference: "MOCK-PAYOUT-" + order.id,
            actualAmount: order.quote.payoutAmount,
            evidence: "MOCK fixture: simulated independent statement match",
          });
      }
    }
    results.push(order.id);
  }
  await core.store.transaction((s) => {
    if (
      s.outbox.some(
        (e) => e.topic === "demo.scenario.created" && e.aggregateId === key,
      )
    )
      return;
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

async function receiptDownload(
  s: Session,
  r: import("../packages/core/src/receipts").PrivateReceipt,
) {
  const expected = `private-receipts/${createHash("sha256")
    .update(s.owner ?? s.token)
    .digest("hex")}/${r.sha256}`;
  demand(r.objectKey === expected, "FORBIDDEN", "Receipt owner mismatch");
  const obj = s.durable ? await s.receiptBucket?.get(r.objectKey) : null;
  const bytes = s.durable
    ? obj
      ? new Uint8Array(await obj.arrayBuffer())
      : undefined
    : s.receiptBlobs.get(r.objectKey);
  demand(
    bytes,
    "NOT_FOUND",
    "Receipt original unavailable; ephemeral previews may expire",
  );
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": r.contentType,
      "content-disposition": `attachment; filename="receipt.${r.contentType === "application/pdf" ? "pdf" : r.contentType === "image/png" ? "png" : "jpg"}"; filename*=UTF-8''${encodeURIComponent(r.fileName).replace(/'/g, "%27")}`,
      "cache-control": "private, no-store, max-age=0",
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox",
      vary: "Cookie, x-demo-actor, oai-authenticated-user-id",
    },
  });
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
  route("GET", "receipts", async (s, a) => ({
    receipts: await s.core.receipts.list(a),
    storageMode: s.workspace
      ? "filesystem_private"
      : s.receiptBucket && s.durable
        ? "r2_private"
        : "ephemeral_private",
  })),
  route("POST", "receipts/upload", async (s, a, b) => {
    requireReceiptAdmin(a);
    const input = z
      .object({
        files: z.array(z.unknown()).min(1).max(10),
        kind: z.enum(["single", "batch"]),
      })
      .strict()
      .parse(b);
    const files = input.files.map(validateReceiptFile);
    // Durable metadata must never point to an ephemeral blob.
    if (s.durable && !s.receiptBucket)
      fail(
        "STORAGE_UNAVAILABLE",
        503,
        "Private receipt storage is not configured",
      );
    const receipts = [];
    for (const f of files) {
      const ownerHash = createHash("sha256")
        .update(s.owner ?? s.token)
        .digest("hex");
      const objectKey = `private-receipts/${ownerHash}/${f.sha256}`;
      const currentState = await s.core.store.read();
      const existing = currentState.privateReceipts?.find(
        (r) => r.sha256 === f.sha256,
      );
      if (!existing) {
        // Reject known capacity exhaustion before any external object write.
        // A concurrent writer can still win after this check; CAS remains authoritative.
        demand(
          (currentState.privateReceipts?.length ?? 0) < 500,
          "STORAGE_CAPACITY",
          "Receipt metadata capacity reached",
        );
        const projected = structuredClone(currentState);
        const projectedId = "00000000-0000-0000-0000-000000000000";
        const projectedAt = new Date().toISOString();
        (projected.privateReceipts ??= []).push({
          id: projectedId,
          fileName: f.fileName,
          contentType: f.contentType,
          size: f.size,
          sha256: f.sha256,
          objectKey,
          kind: input.kind,
          storageMode: s.workspace
            ? "filesystem_private"
            : s.durable
              ? "r2_private"
              : "ephemeral_private",
          uploadedAt: projectedAt,
          uploadedBy: a.id,
          links: [],
        });
        projected.audits.push({
          id: projectedId,
          actorId: a.id,
          action: "receipt.private_uploaded",
          targetId: projectedId,
          data: { sha256: f.sha256, size: f.size, kind: input.kind },
          at: projectedAt,
        });
        demand(
          s.workspace ||
            encoder.encode(JSON.stringify(projected)).byteLength <=
              (s.durable ? D1_MAX_STATE_BYTES : PREVIEW_LIMITS.maxStateBytes),
          "STORAGE_CAPACITY",
          "Receipt metadata capacity reached",
        );
        if (s.receiptBucket && s.durable)
          await s.receiptBucket.put(objectKey, f.bytes, {
            httpMetadata: { contentType: f.contentType },
          });
        else {
          if (s.receiptBlobs.size >= 50)
            fail("STORAGE_CAPACITY", 413, "Ephemeral receipt capacity reached");
          s.receiptBlobs.set(objectKey, f.bytes);
        }
      }
      // Never delete on error: an unknown D1 outcome may already have committed.
      receipts.push(
        await s.core.receipts.register(a, {
          fileName: f.fileName,
          contentType: f.contentType,
          size: f.size,
          sha256: f.sha256,
          objectKey,
          kind: input.kind,
          storageMode: s.workspace
            ? "filesystem_private"
            : s.durable
              ? "r2_private"
              : "ephemeral_private",
        }),
      );
    }
    return {
      receipts,
      storageMode: s.workspace
        ? "filesystem_private"
        : s.durable
          ? "r2_private"
          : "ephemeral_private",
    };
  }),
  route("POST", `receipts/${pathId}/recognition`, (s, a, b, id) =>
    s.core.receipts.recognize(a, id, b),
  ),
  route("POST", `receipts/${pathId}/link`, (s, a, b, id) =>
    s.core.receipts.link(a, id, b),
  ),
  route("POST", `receipts/${pathId}/publish`, (s, a, b, id) =>
    s.core.receipts.publish(a, id, b),
  ),
  route("POST", `receipts/${pathId}/publish-batch`, (s, a, b, id) =>
    s.core.receipts.publishBatch(a, id, b),
  ),
  route(
    "GET",
    `batches/${pathId}/published-receipts`,
    async (s, a, _b, id) => ({
      receipts: await s.core.receipts.publishedBatchList(a, id),
    }),
  ),
  route("GET", `orders/${pathId}/published-receipts`, async (s, a, _b, id) => ({
    receipts: await s.core.receipts.publishedList(a, id),
  })),
  route(
    "GET",
    `published-receipts/${pathId}/download`,
    async (s, a, _b, id) => {
      const r = await s.core.receipts.publishedGet(a, id);
      return receiptDownload(s, {
        ...r,
        fileName: `receipt.${r.contentType === "application/pdf" ? "pdf" : r.contentType === "image/png" ? "png" : "jpg"}`,
      });
    },
  ),
  route("GET", `receipts/${pathId}/download`, async (s, a, _b, id) => {
    const r = await s.core.receipts.get(a, id);
    return receiptDownload(s, r);
  }),
  route("GET", "dashboard", async (s, a) => ({
    ...(await s.core.dashboard(a)),
    storageMode: s.durable ? "d1_mock" : "ephemeral_mock",
    storageLimits: s.durable
      ? {
          maxStateBytes: D1_MAX_STATE_BYTES,
          receiptMaxBytes: RECEIPT_MAX_BYTES,
          receiptStorage: s.receiptBucket ? "r2_private" : "unavailable",
          resetEnabled: false,
        }
      : null,
  })),
  route("GET", "audit", (s, a) => s.core.auditTrail(a)),
  route("POST", "admin/pricing/preview", (s, a, b) =>
    s.core.previewPricing(a, b),
  ),
  route("POST", "admin/pricing/publish", (s, a, b) =>
    s.core.publishPricing(a, b),
  ),
  route("POST", "admin/payout-providers", (s, a, b) =>
    s.core.upsertPayoutProvider(a, b),
  ),
  route("POST", "demo/reset", async (s, a, b, _id, now) => {
    authorize(a, "mock.seed");
    if (s.durable)
      fail(
        "RESET_DISABLED",
        403,
        "Persistent synthetic history cannot be reset from the demo UI.",
      );
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
    s.receiptBlobs.clear();
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
  route("POST", "wallet/deposits", (s, a, b) => s.core.depositWallet(a, b)),
  route("POST", `orders/${pathId}/cancel`, (s, a, b, id) =>
    s.core.cancelOrder(a, id, b),
  ),
  route("POST", "orders", (s, a, b) => s.core.createOrder(a, b)),
  route("POST", `orders/${pathId}/manual-payout`, (s, a, b, id) =>
    s.core.confirmManualPayout(a, id, b),
  ),
  route("POST", `orders/${pathId}/complete-recorded-payment`, (s, a, b, id) =>
    s.core.completeRecordedPayment(a, id),
  ),
  route("POST", `orders/${pathId}/mock-payout`, (s, a, b, id) =>
    s.core.confirmMockPayout(a, id, b),
  ),
  route("POST", `orders/${pathId}/receipt-file`, (s, a, b, id) => {
    if (
      s.durable &&
      typeof b.dataBase64 === "string" &&
      Buffer.byteLength(b.dataBase64, "base64") > DURABLE_RECEIPT_MAX_BYTES
    )
      fail(
        "RECEIPT_TOO_LARGE",
        413,
        "Persistent demo receipts are limited to 256 KiB; synthetic history is limited to 1 MiB per signed-in visitor.",
      );
    return s.core.uploadReceiptFile(a, id, b);
  }),
  route("GET", `orders/${pathId}/receipt-file`, (s, a, _b, id) =>
    s.core.downloadReceiptFile(a, id),
  ),
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
  route("POST", "batches/merchant", (s, a, b) =>
    s.core.importMerchantBatch(a, b),
  ),
  route("POST", "batches", (s, a, b) =>
    s.core.importBatch(
      a,
      scalarId.parse(b.customerId),
      scalarId.parse(b.clientBatchId),
      z.string().max(100_000).parse(b.csv),
    ),
  ),
  route("POST", `batches/${pathId}/quote`, (s, a, _b, id) =>
    s.core.quoteBatch(a, id),
  ),
  route("POST", `batches/${pathId}/submit`, (s, a, b, id) =>
    s.core.submitBatch(a, id, b),
  ),
];

/** Shared command adapter: no preview identity/session lookup. Caller MUST authenticate
 * and apply its own route allowlist before calling. Used by the independent Node service. */
export async function dispatchBusinessCommand(options: {
  request: Request;
  core: OfframpService;
  actor: Actor;
  bucket: ReceiptBucket;
  owner: string;
  now?: () => number;
}): Promise<Response> {
  try {
    const { request, core, actor, bucket, owner } = options;
    const pathname = new URL(request.url).pathname;
    const matching = ROUTES.find(
      (r) => r.method === request.method && r.pattern.test(pathname),
    );
    if (!matching) return json({ error: "NOT_FOUND" }, 404);
    const session = {
      core,
      owner,
      token: "",
      receiptBucket: bucket,
      receiptBlobs: new Map(),
      durable: true,
      workspace: true,
    } as Session;
    const body = request.method === "POST" ? await readBody(request) : {};
    const value = await matching.run(
      session,
      actor,
      body,
      matching.pattern.exec(pathname)?.[1] ?? "",
      options.now ?? Date.now,
    );
    if (pathname === "/api/dashboard" && !(value instanceof Response)) {
      Object.assign(value as object, {
        storageMode: "postgres_sandbox",
        storageLimits: {
          receiptMaxBytes: RECEIPT_MAX_BYTES,
          resetEnabled: false,
        },
      });
    }
    const response = value instanceof Response ? value : json(value);
    response.headers.delete("x-preview-mode");
    response.headers.set("x-workspace-mode", "ACCOUNT_BETA_FUNDS_SANDBOX");
    response.headers.set("vary", "Cookie");
    return response;
  } catch (error) {
    const response = safeError(error);
    response.headers.delete("x-preview-mode");
    response.headers.set("vary", "Cookie");
    response.headers.set("x-workspace-mode", "ACCOUNT_BETA_FUNDS_SANDBOX");
    return response;
  }
}

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
  function startSession(
    at: number,
    db?: D1Database,
    owner?: string,
    receiptBucket?: ReceiptBucket,
  ): Session {
    consume(newSessions, at, PREVIEW_LIMITS.newSessionsPerMinute);
    if (sessions.size >= PREVIEW_LIMITS.maxSessions) {
      // Evicts request controls only in D1 mode; persistent history remains intact.
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
      owner,
      receiptBucket,
      receiptBlobs: new Map(),
      durable: !!db,
      token: randomToken(),
      secret: randomToken(),
      createdAt: at,
      touchedAt: at,
      expiresAt: at + PREVIEW_LIMITS.ttlMs,
      core: new OfframpService(
        db ? new D1MockStore(db, owner!) : new BoundedMemoryStore(),
        () => new Date(now()),
      ),
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
        if (request.method === "GET" && url.pathname === "/api/health") {
          if (env.DB) {
            try {
              await env.DB.prepare(
                "SELECT revision FROM offramp_mock_state LIMIT 0",
              ).first();
            } catch {
              return json(
                {
                  status: "unavailable",
                  mode: "MOCK",
                  persistence: "d1_mock",
                  schemaReady: false,
                  realExecutionEnabled: false,
                },
                503,
              );
            }
          }
          return json({
            schemaReady: !!env.DB,
            status: "ok",
            mode: "MOCK",
            realExecutionEnabled: false,
            persistence: env.DB ? "d1_mock" : "session-memory",
            storage: env.DB
              ? {
                  binding: "DB",
                  schema: "offramp_mock_state",
                  scope: "authenticated-site-visitor",
                  resetEnabled: false,
                  maxStateBytes: D1_MAX_STATE_BYTES,
                  receiptMaxBytes: RECEIPT_MAX_BYTES,
                  legacyInlineReceiptMaxBytes: DURABLE_RECEIPT_MAX_BYTES,
                  receiptStorage: env.BUCKET ? "r2_private" : "unavailable",
                }
              : null,
            volatile: !env.DB,
            ttlSeconds: env.DB ? null : PREVIEW_LIMITS.ttlMs / 1000,
            sessionScope: env.DB
              ? "authenticated-site-visitor"
              : "browser-cookie, per Worker isolate",
            syntheticOnly: true,
            note: env.DB
              ? "Bounded synthetic history in D1, scoped to the signed-in Site visitor. Demo roles are simulations; no real funds or provider execution."
              : "Synthetic state may disappear on expiry, eviction, deployment, or Worker restart. No durable storage or provider execution.",
          });
        }
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
        // These headers are injected by the Sites authenticated gateway, never by
        // the demo actor picker. Do not serve this Worker outside that boundary.
        const owner = env.DB
          ? request.headers.get("oai-authenticated-user-id")
          : undefined;
        if (env.DB && (!owner || owner.length > 256))
          fail(
            "UNAUTHENTICATED",
            401,
            "Sign in to ChatGPT to access your synthetic history.",
          );
        const actorKey = request.headers.get("x-demo-actor") ?? "";
        if (!Object.prototype.hasOwnProperty.call(ACTORS, actorKey))
          fail("UNAUTHENTICATED", 401, "Select a known demo fixture actor.");
        const actor = ACTORS[actorKey];
        const token = sessionCookie(request);
        let session = token ? sessions.get(token) : undefined;
        if (
          session &&
          (session.expiresAt <= at ||
            session.owner !== (owner ?? undefined) ||
            session.durable !== !!env.DB)
        )
          session = undefined;
        let cookie: string | undefined;
        if (!session) {
          if (request.method !== "GET" || url.pathname !== "/api/dashboard")
            fail(
              "SESSION_EXPIRED",
              410,
              "Preview session is missing or expired. Reload the dashboard to start a fresh synthetic session.",
            );
          session = startSession(at, env.DB, owner ?? undefined, env.BUCKET);
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
          if (
            env.MARKET_RATES &&
            (url.pathname === "/api/dashboard" ||
              /\/(?:quotes|batch-quotes)$/.test(url.pathname))
          ) {
            const required = isCommand;
            try {
              const response = await env.MARKET_RATES.fetch(
                new Request("https://reference.internal/"),
              );
              const status = (await response.json()) as any;
              const snapshot = status.snapshot;
              if (
                !response.ok ||
                status.stale ||
                !snapshot ||
                !Number.isFinite(Date.parse(snapshot.fetchedAt)) ||
                Date.parse(snapshot.fetchedAt) > now() ||
                now() - Date.parse(snapshot.fetchedAt) > 30 * 60000
              )
                throw new Error("stale");
              const system = {
                id: "system-market-reference",
                role: "merchant_admin" as const,
              };
              const current = (await session!.core.dashboard(system))
                .pricingCurrent!;
              if (current.marketReference?.batchId !== snapshot.batchId)
                await session!.core.publishPricing(
                  system,
                  referencePricing(snapshot, current),
                  snapshot,
                );
            } catch (error) {
              if (required)
                fail("REFERENCE_UNAVAILABLE", 503, "汇率暂不可用，请稍后重试");
            }
          }
          return matching.run(session!, actor, body, id, now);
        });
        return value instanceof Response ? value : json(value, 200, cookie);
      } catch (error) {
        return safeError(error);
      }
    },
  };
}
