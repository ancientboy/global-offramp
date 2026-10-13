import { createHmac } from "node:crypto";
const base = process.env.API_URL ?? "http://127.0.0.1:3001/api";
const secret = process.env.WEBHOOK_SECRET;
if (!secret || secret.length < 32)
  throw Error(
    "Set the same WEBHOOK_SECRET as the running API (32+ chars, mock only)",
  );
async function post(path: string, data: unknown, actor = "customer-demo") {
  const response = await fetch(base + "/" + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-actor": actor },
    body: JSON.stringify(data),
  });
  const result = (await response.json()) as any;
  if (!response.ok) throw Error(JSON.stringify(result));
  return result;
}
async function main() {
  const q = await post("quotes", {
    customerId: "customer-1",
    beneficiaryId: "beneficiary-cn",
    sourceCurrency: "USDT",
    sourceAmount: "1000",
  });
  const o = await post("orders", {
    quoteId: q.id,
    clientOrderId: "demo-" + crypto.randomUUID(),
  });
  const event = {
    eventId: "ev-" + o.id,
    transactionId: "tx-" + o.id,
    orderId: o.id,
    currency: "USDT",
    amount: q.totalDeposit,
    network: "MOCK",
    confirmations: 1,
  };
  const body = JSON.stringify(event),
    timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret!)
    .update(timestamp + "." + body)
    .digest("hex");
  const response = await fetch(base + "/webhooks/mock-deposit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-webhook-timestamp": timestamp,
      "x-webhook-signature": signature,
    },
    body,
  });
  if (!response.ok) throw Error(await response.text());
  await post(
    `orders/${o.id}/conversion`,
    {
      providerReference: "fx-" + o.id,
      actualRate: q.customerRate,
      evidence: "MOCK conversion allocation record",
    },
    "checker-demo",
  );
  const a = await post(
    `orders/${o.id}/attempts`,
    { idempotencyKey: "pay-" + o.id },
    "maker-demo",
  );
  await post(`attempts/${a.id}/approve`, {}, "checker-demo");
  await post(
    `attempts/${a.id}/record`,
    {
      outcome: "sent",
      providerReference: "provider-" + o.id,
      evidence: "MOCK portal confirmed sent",
    },
    "maker-demo",
  );
  await post(
    `orders/${o.id}/reconcile`,
    {
      providerReference: "provider-" + o.id,
      actualAmount: q.payoutAmount,
      evidence: "MOCK statement independently verified",
    },
    "checker-demo",
  );
  console.log(
    JSON.stringify(
      {
        mode: "MOCK",
        orderId: o.id,
        deposit: "confirmed",
        payout: "sent",
        receipt: "none",
        reconciled: true,
        commission: "1.000000 USDT (fixture only; no payment)",
      },
      null,
      2,
    ),
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
