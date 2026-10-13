import { createHmac, timingSafeEqual } from "node:crypto";
import { demand } from "./money";
import { Actor, Role } from "./types";
const RULES: Record<string, readonly Role[]> = {
  "mock.seed": ["operations"],
  "mock.deposit": ["operations"],
  "quote.create": ["customer", "operations"],
  "order.create": ["customer", "operations"],
  "order.read": ["customer", "operations", "finance", "auditor"],
  "beneficiary.create": ["customer", "operations"],
  "beneficiary.approve": ["finance"],
  "batch.create": ["customer", "operations"],
  "payout.prepare": ["operations"],
  "payout.approve": ["finance"],
  "payout.record": ["operations"],
  "payout.resolve": ["finance"],
  "conversion.record": ["finance"],
  "receipt.upload": ["operations", "finance"],
  reconcile: ["finance"],
  "refund.request": ["operations"],
  "refund.approve": ["finance"],
  "refund.record": ["operations"],
  "settlement.create": ["finance"],
  "settlement.approve": ["finance"],
  "settlement.cancel": ["finance"],
  "commission.read": ["partner", "finance", "auditor"],
  "audit.read": ["auditor", "finance"],
  "customer.review": ["finance"],
  "customer.create": ["operations"],
  "discrepancy.resolve": ["finance"],
};
export function authorize(
  actor: Actor,
  action: string,
  customerId?: string,
): void {
  demand(
    !!actor?.id && (RULES[action]?.includes(actor.role) ?? false),
    "FORBIDDEN",
    "Operation is not allowed for this role",
  );
  if (actor.role === "customer")
    demand(
      !!actor.customerId && actor.customerId === customerId,
      "FORBIDDEN",
      "Customer scope mismatch",
    );
}
export function maskAudit(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([k, v]) => [
      k,
      /account|token|secret|password|signature|evidence|name|email|address/i.test(
        k,
      )
        ? "[REDACTED]"
        : Array.isArray(v)
          ? v.map((item) =>
              item && typeof item === "object"
                ? maskAudit(item as Record<string, unknown>)
                : item,
            )
          : v && typeof v === "object"
            ? maskAudit(v as Record<string, unknown>)
            : v,
    ]),
  );
}
export function verifyWebhook(
  raw: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  now: Date,
): void {
  demand(
    secret.length >= 32,
    "CONFIG",
    "Webhook secret must be at least 32 characters",
  );
  demand(
    /^\d{10}$/.test(timestamp) &&
      Math.abs(now.getTime() / 1000 - Number(timestamp)) <= 300,
    "WEBHOOK_EXPIRED",
    "Webhook timestamp outside 5 minute window",
  );
  demand(
    /^[a-f0-9]{64}$/.test(signature),
    "BAD_SIGNATURE",
    "Invalid signature",
  );
  const expected = createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(raw)
    .digest();
  demand(
    timingSafeEqual(expected, Buffer.from(signature, "hex")),
    "BAD_SIGNATURE",
    "Invalid signature",
  );
}
export function signWebhook(
  raw: Buffer,
  timestamp: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(raw)
    .digest("hex");
}
export function assertSafeRuntime(env: NodeJS.ProcessEnv): void {
  demand(
    env.EXECUTION_MODE === "mock",
    "REAL_EXECUTION_DISABLED",
    "Only EXECUTION_MODE=mock is supported",
  );
  demand(
    env.NODE_ENV !== "production",
    "PRODUCTION_AUTH_REQUIRED",
    "Production startup is disabled until a reviewed identity provider, MFA and authorization integration is implemented",
  );
  demand(
    env.DEMO_AUTH === "true",
    "AUTH_REQUIRED",
    "Explicit DEMO_AUTH=true is required for isolated mock environments",
  );
}
