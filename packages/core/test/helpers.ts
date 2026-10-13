import { OfframpService } from "../src/service";
import { MemoryStore } from "../src/store";
import { ACTORS } from "../src/fixtures";
import { signWebhook } from "../src/security";
export const SECRET = "mock-test-secret-at-least-32-characters";
export const customer = ACTORS["customer-demo"];
export const maker = ACTORS["maker-demo"];
export const checker = ACTORS["checker-demo"];
export function harness() {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new MemoryStore();
  const service = new OfframpService(store, () => now);
  return {
    store,
    service,
    get now() {
      return now;
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}
export async function order(
  h: ReturnType<typeof harness>,
  sourceAmount = "1000",
) {
  const q = await h.service.createQuote(customer, {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDT",
    sourceAmount,
  });
  return (await h.service.createOrder(customer, {
    quoteId: q.id,
    clientOrderId: "order-" + crypto.randomUUID(),
  })) as any;
}
export async function deposit(
  h: ReturnType<typeof harness>,
  o: any,
  patch: Record<string, unknown> = {},
) {
  const raw = Buffer.from(
    JSON.stringify({
      eventId: "ev-" + o.id,
      transactionId: "tx-" + o.id,
      orderId: o.id,
      currency: "USDT",
      amount: o.quote.totalDeposit,
      network: "MOCK",
      confirmations: 1,
      ...patch,
    }),
  );
  const timestamp = Math.floor(h.now.getTime() / 1000).toString();
  return h.service.receiveDeposit(
    raw,
    timestamp,
    signWebhook(raw, timestamp, SECRET),
    SECRET,
  );
}
export async function ready(h: ReturnType<typeof harness>) {
  const o = await order(h);
  await deposit(h, o);
  await h.service.recordConversion(checker, o.id, {
    providerReference: "fx-" + o.id,
    actualRate: "7.20000000",
    evidence: "Mock external conversion allocation evidence",
  });
  return o;
}
export async function sent(h: ReturnType<typeof harness>) {
  const o = await ready(h);
  const a = await h.service.preparePayout(maker, o.id, "pay-" + o.id);
  await h.service.approvePayout(checker, a.id);
  await h.service.recordPayout(maker, a.id, {
    outcome: "sent",
    providerReference: "payref-" + o.id,
    evidence: "Mock portal result evidence",
  });
  return { o, a };
}
