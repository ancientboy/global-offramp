import { randomUUID } from "node:crypto";
import { z } from "zod";
import { OfframpService } from "../../../packages/core/src/service";
import { Actor } from "../../../packages/core/src/types";
import { ACTORS } from "../../../packages/core/src/fixtures";
import {
  authorize,
  assertSafeRuntime,
  signWebhook,
} from "../../../packages/core/src/security";
import { demand } from "../../../packages/core/src/money";
/** Explicit mock fixture tooling. No external action or user-supplied financial override. */
export class MockScenarioService {
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly core: OfframpService) {}
  private async serial<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise((r) => (release = r));
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
  async deposit(actor: Actor, orderId: string) {
    assertSafeRuntime(process.env);
    authorize(actor, "mock.deposit");
    const order = (await this.core.store.read()).orders.find(
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
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const secret = process.env.WEBHOOK_SECRET ?? "";
    return this.core.receiveDeposit(
      raw,
      timestamp,
      signWebhook(raw, timestamp, secret),
      secret,
    );
  }
  async seed(actor: Actor, input: unknown) {
    assertSafeRuntime(process.env);
    authorize(actor, "mock.seed");
    const { idempotencyKey } = z
      .object({
        idempotencyKey: z
          .string()
          .min(1)
          .max(40)
          .regex(/^[a-zA-Z0-9_-]+$/),
      })
      .strict()
      .parse(input);
    return this.serial(async () => {
      const key = "demo-scenario:" + idempotencyKey;
      const existing = (await this.core.store.read()).outbox.find(
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
        let o = (await this.core.store.read()).orders.find(
          (x) =>
            x.clientOrderId === clientOrderId && x.customerId === "customer-1",
        );
        if (!o) {
          const q = await this.core.createQuote(actor, {
            customerId: "customer-1",
            beneficiaryId: spec.beneficiaryId,
            sourceCurrency: spec.sourceCurrency,
            sourceAmount: spec.sourceAmount,
          });
          await this.core.createOrder(actor, { quoteId: q.id, clientOrderId });
          o = (await this.core.store.read()).orders.find(
            (x) =>
              x.clientOrderId === clientOrderId &&
              x.customerId === "customer-1",
          )!;
        }
        if (o.depositStatus === "awaiting") await this.deposit(actor, o.id);
        if (spec.label !== "funded") {
          o = (await this.core.store.read()).orders.find(
            (x) => x.id === o!.id,
          )!;
          if (o.conversionStatus === "pending")
            await this.core.recordConversion(ACTORS["checker-demo"], o.id, {
              providerReference: "demo-fx-" + o.id,
              actualRate: o.quote.customerRate,
              evidence:
                "MOCK fixture: external allocation record; no conversion occurred",
            });
          let a = (await this.core.store.read()).attempts.find(
            (x) => x.orderId === o!.id,
          );
          if (!a)
            a = await this.core.preparePayout(
              ACTORS["maker-demo"],
              o.id,
              "demo-pay-" + o.id,
            );
          if (a.state === "awaiting_approval")
            await this.core.approvePayout(ACTORS["checker-demo"], a.id);
          if (spec.label === "reconciled") {
            a = (await this.core.store.read()).attempts.find(
              (x) => x.id === a!.id,
            )!;
            if (a.state === "approved")
              await this.core.recordPayout(ACTORS["maker-demo"], a.id, {
                outcome: "sent",
                providerReference: "demo-provider-" + o.id,
                evidence:
                  "MOCK fixture: simulated portal success; no money sent",
              });
            o = (await this.core.store.read()).orders.find(
              (x) => x.id === o!.id,
            )!;
            if (o.payoutStatus === "sent" && !o.reconciled)
              await this.core.reconcile(ACTORS["checker-demo"], o.id, {
                providerReference: "demo-provider-" + o.id,
                actualAmount: o.quote.payoutAmount,
                evidence: "MOCK fixture: simulated independent statement match",
              });
          }
        }
        results.push(o.id);
      }
      await this.core.store.transaction((s) => {
        const now = new Date().toISOString();
        s.outbox.push({
          id: randomUUID(),
          topic: "demo.scenario.created",
          aggregateId: key,
          payload: { orderIds: results, fixtureOnly: true },
          createdAt: now,
        });
        s.audits.push({
          id: randomUUID(),
          actorId: actor.id,
          action: "demo.scenario.created",
          targetId: key,
          data: { orderCount: results.length, fixtureOnly: true },
          at: now,
        });
      });
      return { mode: "MOCK", fixtureOnly: true, orderIds: results };
    });
  }
}
