import { createHash, randomUUID } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import {
  amount,
  add,
  convert,
  decimal,
  demand,
  proportion,
  SCALE,
  units,
} from "./money";
import {
  Actor,
  Beneficiary,
  Commission,
  Order,
  Outbox,
  Quote,
  State,
  Store,
} from "./types";
import { CONFIG } from "./fixtures";
import { authorize, maskAudit, verifyWebhook } from "./security";
import { transfer } from "./ledger";
const id = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9_-]+$/);
const decimalString = z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,8})?$/);
const text = z.string().min(3).max(500);
const quoteInput = z
  .object({
    customerId: id,
    beneficiaryId: id,
    sourceCurrency: z.enum(["USDT", "USDC"]),
    sourceAmount: decimalString.optional(),
    targetAmount: decimalString.optional(),
    payoutCurrency: z.enum(["CNY", "USD"]).optional(),
    amountMode: z
      .enum(["principal", "total_deposit", "target_payout"])
      .optional(),
  })
  .strict();
const eventSchema = z
  .object({
    eventId: id,
    transactionId: id,
    orderId: id,
    currency: z.enum(["USDT", "USDC"]),
    amount: decimalString,
    network: z.literal("MOCK"),
    confirmations: z.number().int().min(1).max(10000),
  })
  .strict();
export class OfframpService {
  constructor(
    public readonly store: Store,
    private readonly clock: () => Date = () => new Date(),
    private readonly config: typeof CONFIG = CONFIG,
  ) {}
  private audit(
    s: State,
    a: Actor,
    action: string,
    targetId: string,
    data: Record<string, unknown> = {},
  ) {
    s.audits.push({
      id: randomUUID(),
      actorId: a.id,
      action,
      targetId,
      data: maskAudit(data),
      at: this.clock().toISOString(),
    });
  }
  private emit(
    s: State,
    topic: string,
    aggregateId: string,
    payload: Record<string, unknown> = {},
  ) {
    s.outbox.push({
      id: randomUUID(),
      topic,
      aggregateId,
      payload,
      createdAt: this.clock().toISOString(),
    });
  }
  private order(s: State, orderId: string): Order {
    const o = s.orders.find((x) => x.id === orderId);
    demand(o, "NOT_FOUND", "Order not found");
    return o;
  }
  private checkCustomer(s: State, customerId: string) {
    const c = s.customers.find((x) => x.id === customerId);
    demand(
      c?.status === "approved",
      "CUSTOMER_BLOCKED",
      "Customer must be approved",
    );
    return c;
  }
  private checkBeneficiary(
    s: State,
    customerId: string,
    beneficiaryId: string,
  ) {
    const b = s.beneficiaries.find(
      (x) => x.id === beneficiaryId && x.customerId === customerId,
    );
    demand(
      b?.status === "approved",
      "BENEFICIARY_BLOCKED",
      "Whitelisted beneficiary required",
    );
    return b;
  }
  private quote(s: State, input: z.infer<typeof quoteInput>): Quote {
    const customer = this.checkCustomer(s, input.customerId);
    const beneficiary = this.checkBeneficiary(
      s,
      input.customerId,
      input.beneficiaryId,
    );
    const route = this.config.routes[beneficiary.currency];
    demand(
      route.enabled && route.country === beneficiary.country,
      "ROUTE_DISABLED",
      "Route unavailable",
    );
    const amountMode = input.amountMode ?? "principal";
    demand(
      amountMode === "target_payout"
        ? !!input.targetAmount && input.sourceAmount === undefined
        : !!input.sourceAmount && input.targetAmount === undefined,
      "INVALID_AMOUNT_MODE",
      "Provide only targetAmount for target_payout, otherwise sourceAmount",
    );
    demand(
      !input.payoutCurrency || input.payoutCurrency === beneficiary.currency,
      "CURRENCY_MISMATCH",
      "Target currency must match beneficiary",
    );
    const inputAmount = amount(
      amountMode === "target_payout"
        ? input.targetAmount!
        : input.sourceAmount!,
      amountMode === "target_payout"
        ? beneficiary.currency
        : input.sourceCurrency,
    );
    const serviceFee = amount(
      customer.serviceFeeOverride ?? this.config.serviceFee,
      input.sourceCurrency,
    );
    const channelFee = amount(this.config.channelFee, input.sourceCurrency);
    const rate = units(route.customerRate, 8);
    demand(rate > 0n, "INVALID_RATE", "Rate must be positive");
    const numerator =
      amountMode === "target_payout"
        ? units(inputAmount, 2) * 1000000n * 100000000n
        : 0n;
    const denominator = rate * 100n;
    const principalUnits =
      amountMode === "target_payout"
        ? (numerator + denominator - 1n) / denominator
        : amountMode === "total_deposit"
          ? units(inputAmount, 6) - units(serviceFee, 6) - units(channelFee, 6)
          : units(inputAmount, 6);
    demand(
      principalUnits > 0n,
      "INVALID_AMOUNT",
      "Amount must leave positive principal after applicable fees",
    );
    const principal = decimal(principalUnits, 6);
    const now = this.clock();
    const q: Quote = {
      id: randomUUID(),
      customerId: customer.id,
      beneficiaryId: beneficiary.id,
      sourceCurrency: input.sourceCurrency,
      payoutCurrency: beneficiary.currency,
      sourceAmount: principal,
      amountMode,
      inputAmount,
      inputCurrency:
        amountMode === "target_payout"
          ? beneficiary.currency
          : input.sourceCurrency,
      ...(amountMode === "target_payout"
        ? { requestedPayoutAmount: inputAmount }
        : {}),
      payoutAmount: convert(
        principal,
        input.sourceCurrency,
        beneficiary.currency,
        route.customerRate,
      ),
      serviceFee,
      channelFee,
      totalDeposit: add(
        add(principal, serviceFee, input.sourceCurrency),
        channelFee,
        input.sourceCurrency,
      ),
      costRate: route.costRate,
      referenceRate: route.referenceRate,
      customerRate: route.customerRate,
      configVersion: this.config.version,
      feeRuleVersion: this.config.feeRuleVersion,
      partnerId: customer.partnerId,
      attributionVersion: customer.attributionVersion,
      commissionRate: customer.partnerId
        ? this.config.commissionRate
        : "0.00000000",
      commissionRuleVersion: this.config.commissionRuleVersion,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + this.config.quoteTtlSeconds * 1000,
      ).toISOString(),
    };
    demand(
      units(q.payoutAmount, 2) > 0n,
      "INVALID_AMOUNT",
      "Payout rounds to zero",
    );
    if (amountMode === "target_payout")
      demand(
        q.payoutAmount === inputAmount,
        "UNREPRESENTABLE_AMOUNT",
        "Target cannot be represented at supported precision",
      );
    s.quotes.push(q);
    return q;
  }
  async createCustomer(actor: Actor, input: unknown) {
    const v = z
      .object({ kind: z.enum(["personal", "company"]), name: text })
      .strict()
      .parse(input);
    authorize(actor, "customer.create");
    return this.store.transaction((s) => {
      const c = { id: randomUUID(), ...v, status: "pending" as const };
      s.customers.push(c);
      this.audit(s, actor, "customer.created", c.id);
      return c;
    });
  }
  async reviewCustomer(
    actor: Actor,
    customerId: string,
    status: "approved" | "suspended",
  ) {
    authorize(actor, "customer.review");
    demand(
      ["approved", "suspended"].includes(status),
      "INVALID_STATUS",
      "Invalid customer status",
    );
    return this.store.transaction((s) => {
      const c = s.customers.find((x) => x.id === customerId);
      demand(c, "NOT_FOUND", "Customer missing");
      c.status = status;
      this.audit(s, actor, "customer.reviewed", c.id, { status });
      return c;
    });
  }
  async createBeneficiary(actor: Actor, input: unknown) {
    const v = z
      .object({
        customerId: id,
        name: text,
        country: z.enum(["CN", "US"]),
        currency: z.enum(["CNY", "USD"]),
        accountToken: id,
        accountMasked: z.string().regex(/^\*{4} \d{4}$/),
      })
      .strict()
      .parse(input);
    authorize(actor, "beneficiary.create", v.customerId);
    return this.store.transaction((s) => {
      this.checkCustomer(s, v.customerId);
      demand(
        this.config.routes[v.currency].country === v.country,
        "ROUTE_MISMATCH",
        "Country and currency mismatch",
      );
      const b: Beneficiary = {
        id: randomUUID(),
        ...v,
        status: "pending",
        createdBy: actor.id,
      };
      s.beneficiaries.push(b);
      this.audit(s, actor, "beneficiary.created", b.id, {
        accountToken: v.accountToken,
      });
      return b;
    });
  }
  async approveBeneficiary(actor: Actor, beneficiaryId: string) {
    authorize(actor, "beneficiary.approve");
    return this.store.transaction((s) => {
      const b = s.beneficiaries.find((x) => x.id === beneficiaryId);
      demand(
        b && b.status === "pending",
        "INVALID_STATE",
        "Pending beneficiary required",
      );
      demand(
        actor.role === "merchant_admin" || b.createdBy !== actor.id,
        "MAKER_CHECKER",
        "Creator cannot approve beneficiary",
      );
      b.status = "approved";
      b.approvedBy = actor.id;
      this.audit(s, actor, "beneficiary.approved", b.id);
      return b;
    });
  }
  async createQuote(actor: Actor, input: unknown) {
    const v = quoteInput.parse(input);
    authorize(actor, "quote.create", v.customerId);
    return this.store.transaction((s) => {
      const q = this.quote(s, v);
      this.audit(s, actor, "quote.created", q.id);
      return this.quoteView(q, actor);
    });
  }
  private makeOrder(
    s: State,
    actor: Actor,
    quoteId: string,
    clientOrderId: string,
    batchId?: string,
  ) {
    const q = s.quotes.find((x) => x.id === quoteId);
    demand(q, "NOT_FOUND", "Quote missing");
    authorize(actor, "order.create", q.customerId);
    const existing = s.orders.find(
      (x) => x.customerId === q.customerId && x.clientOrderId === clientOrderId,
    );
    if (existing) {
      demand(
        existing.quote.id === quoteId,
        "IDEMPOTENCY_CONFLICT",
        "Client order key was used for a different quote",
      );
      return existing;
    }
    demand(
      Date.parse(q.expiresAt) > this.clock().getTime(),
      "QUOTE_EXPIRED",
      "Request a new quote",
    );
    demand(
      !s.orders.some((o) => o.quote.id === q.id),
      "QUOTE_CONSUMED",
      "Quote already used",
    );
    this.checkCustomer(s, q.customerId);
    this.checkBeneficiary(s, q.customerId, q.beneficiaryId);
    const order: Order = {
      id: randomUUID(),
      customerId: q.customerId,
      quote: structuredClone(q),
      clientOrderId,
      depositStatus: "awaiting",
      conversionStatus: "pending",
      payoutStatus: "draft",
      receiptStatus: "none",
      reconciled: false,
      createdAt: this.clock().toISOString(),
      ...(batchId ? { batchId } : {}),
    };
    order.fundingExpiresAt = new Date(
      this.clock().getTime() + 30 * 60 * 1000,
    ).toISOString();
    order.fundingInstruction = {
      mode: "mock",
      payable: false,
      status: "mock_nonpayable",
      reference: "MOCK-" + order.id,
      network: "MOCK",
      address: null,
      currency: q.sourceCurrency,
      amount: q.totalDeposit,
      expiresAt: order.fundingExpiresAt,
    };
    s.orders.push(order);
    this.audit(s, actor, "order.created", order.id);
    this.emit(s, "order.created", order.id);
    return order;
  }
  async createOrder(actor: Actor, input: unknown) {
    const v = z
      .object({ quoteId: id, clientOrderId: id })
      .strict()
      .parse(input);
    return this.store.transaction((s) =>
      this.orderView(
        this.makeOrder(s, actor, v.quoteId, v.clientOrderId),
        actor,
      ),
    );
  }
  async receiveDeposit(
    raw: Buffer,
    timestamp: string,
    signature: string,
    secret: string,
  ) {
    verifyWebhook(raw, timestamp, signature, secret, this.clock());
    const v = eventSchema.parse(JSON.parse(raw.toString("utf8")));
    const { eventId: _eventId, ...transactionData } = v;
    const hash = createHash("sha256")
      .update(JSON.stringify(transactionData))
      .digest("hex");
    return this.store.transaction((s) => {
      const duplicate = s.webhookEvents.find(
        (x) => x.id === v.eventId || x.transactionId === v.transactionId,
      );
      if (duplicate) {
        demand(
          duplicate.hash === hash,
          "EVENT_CONFLICT",
          "Event id was reused with changed payload",
        );
        return { duplicate: true };
      }
      const o = this.order(s, v.orderId);
      demand(
        v.currency === o.quote.sourceCurrency,
        "CURRENCY_MISMATCH",
        "Deposit currency differs from quote",
      );
      const value = amount(v.amount, v.currency);
      demand(
        units(value, 6) > 0n,
        "INVALID_AMOUNT",
        "Deposit must be positive",
      );
      s.webhookEvents.push({
        id: v.eventId,
        transactionId: v.transactionId,
        hash,
      });
      const matches =
        o.depositStatus === "awaiting" &&
        value === o.quote.totalDeposit &&
        Date.parse(o.fundingExpiresAt ?? o.quote.expiresAt) >
          this.clock().getTime();
      transfer(
        s,
        "deposit:" + v.transactionId,
        v.currency,
        value,
        "asset:custody:mock",
        matches
          ? "liability:order:" + o.id
          : "liability:unallocated:" + v.transactionId,
        this.clock(),
      );
      if (matches) {
        o.depositStatus = "confirmed";
        o.depositEventId = v.eventId;
      } else {
        if (o.depositStatus === "awaiting") o.depositStatus = "exception";
        s.discrepancies.push({
          id: randomUUID(),
          orderId: o.id,
          kind: "deposit_mismatch",
          detail:
            "Late, unexpected, underpaid or overpaid deposit held unallocated; manual resolution required.",
          status: "open",
        });
      }
      this.audit(
        s,
        { id: "mock-custody", role: "operations" },
        "deposit.received",
        o.id,
        {
          eventId: v.eventId,
          transactionId: v.transactionId,
          status: o.depositStatus,
        },
      );
      this.emit(s, matches ? "deposit.confirmed" : "deposit.exception", o.id);
      return {
        duplicate: false,
        orderId: o.id,
        depositStatus: o.depositStatus,
      };
    });
  }
  async recordConversion(actor: Actor, orderId: string, input: unknown) {
    authorize(actor, "conversion.record");
    const v = z
      .object({
        providerReference: id,
        actualRate: decimalString,
        evidence: text,
      })
      .strict()
      .parse(input);
    return this.store.transaction((s) => {
      const o = this.order(s, orderId);
      demand(
        o.depositStatus === "confirmed" && o.conversionStatus === "pending",
        "INVALID_STATE",
        "Confirmed deposit and pending conversion required",
      );
      this.checkCustomer(s, o.customerId);
      demand(
        !s.refunds.some((r) => r.orderId === o.id && r.kind === "principal"),
        "REFUND_CONFLICT",
        "Principal refund blocks original conversion",
      );
      demand(
        !s.orders.some(
          (x) => x.conversion?.providerReference === v.providerReference,
        ),
        "DUPLICATE_REFERENCE",
        "Provider conversion reference already recorded",
      );
      demand(
        convert(
          o.quote.sourceAmount,
          o.quote.sourceCurrency,
          o.quote.payoutCurrency,
          v.actualRate,
        ) === o.quote.payoutAmount,
        "CONVERSION_MISMATCH",
        "Recorded external conversion must allocate exactly the quote payout. Spread/cost differences require a separately reconciled treasury record.",
      );
      transfer(
        s,
        "conversion-source:" + o.id,
        o.quote.sourceCurrency,
        o.quote.sourceAmount,
        "liability:order:" + o.id,
        "asset:custody:mock",
        this.clock(),
      );
      transfer(
        s,
        "conversion-target:" + o.id,
        o.quote.payoutCurrency,
        o.quote.payoutAmount,
        "asset:provider:mock",
        "liability:payout:" + o.id,
        this.clock(),
      );
      o.conversionStatus = "recorded";
      o.conversion = { ...v, recordedBy: actor.id };
      this.audit(s, actor, "conversion.recorded", o.id, {
        providerReference: v.providerReference,
        actualRate: v.actualRate,
        evidence: v.evidence,
      });
      return this.orderView(o, actor);
    });
  }
  async preparePayout(actor: Actor, orderId: string, key: string) {
    authorize(actor, "payout.prepare");
    id.parse(key);
    return this.store.transaction((s) => {
      const o = this.order(s, orderId);
      const old = s.attempts.find((a) => a.idempotencyKey === key);
      if (old) {
        demand(
          old.orderId === orderId,
          "IDEMPOTENCY_CONFLICT",
          "Payout key belongs to another order",
        );
        return old;
      }
      this.checkCustomer(s, o.customerId);
      this.checkBeneficiary(s, o.customerId, o.quote.beneficiaryId);
      demand(
        o.depositStatus === "confirmed" && o.conversionStatus === "recorded",
        "FUNDS_NOT_READY",
        "Deposit and external conversion must be confirmed",
      );
      demand(
        ["draft", "failed"].includes(o.payoutStatus),
        "PAYOUT_LOCKED",
        "Existing payout is active, sent or unknown. Verify it before retrying.",
      );
      const previous = s.attempts.filter((x) => x.orderId === o.id).at(-1);
      if (previous)
        demand(
          previous.state === "failed" && !!previous.verifiedBy,
          "VERIFY_BEFORE_RETRY",
          "Finance must verify no payment occurred before retry",
        );
      const attempt = {
        id: randomUUID(),
        orderId,
        idempotencyKey: key,
        makerId: actor.id,
        state: "awaiting_approval" as const,
        createdAt: this.clock().toISOString(),
      };
      s.attempts.push(attempt);
      o.payoutStatus = "awaiting_approval";
      this.audit(s, actor, "payout.prepared", orderId, {
        attemptId: attempt.id,
      });
      return attempt;
    });
  }
  async approvePayout(actor: Actor, attemptId: string) {
    authorize(actor, "payout.approve");
    return this.store.transaction((s) => {
      const a = s.attempts.find((x) => x.id === attemptId);
      demand(
        a && a.state === "awaiting_approval",
        "INVALID_STATE",
        "Pending attempt required",
      );
      demand(
        actor.role === "merchant_admin" || a.makerId !== actor.id,
        "MAKER_CHECKER",
        "Maker cannot approve own payout",
      );
      const o = this.order(s, a.orderId);
      this.checkCustomer(s, o.customerId);
      this.checkBeneficiary(s, o.customerId, o.quote.beneficiaryId);
      a.checkerId = actor.id;
      a.state = "approved";
      o.payoutStatus = "approved";
      this.audit(s, actor, "payout.approved", o.id, { attemptId });
      this.emit(s, "payout.manual-ready", o.id, { attemptId });
      return a;
    });
  }
  private recordSent(s: State, o: Order) {
    if (!s.journals.some((j) => j.businessKey === "payout:" + o.id)) {
      transfer(
        s,
        "payout:" + o.id,
        o.quote.payoutCurrency,
        o.quote.payoutAmount,
        "liability:payout:" + o.id,
        "asset:provider:mock",
        this.clock(),
      );
      for (const [name, value] of [
        ["service", o.quote.serviceFee],
        ["channel", o.quote.channelFee],
      ])
        if (units(value, 6) > 0n)
          transfer(
            s,
            "fee-" + name + ":" + o.id,
            o.quote.sourceCurrency,
            value,
            "liability:order:" + o.id,
            name === "service"
              ? "revenue:service-fee"
              : "liability:channel-fee",
            this.clock(),
          );
    }
    o.payoutStatus = "sent";
  }
  async recordPayout(actor: Actor, attemptId: string, input: unknown) {
    authorize(actor, "payout.record");
    demand(
      actor.role !== "merchant_admin",
      "USE_MANUAL_PAYOUT",
      "Merchant administrator must use the amount-checked manual payout endpoint",
    );
    const v = z
      .object({
        outcome: z.enum(["sent", "unknown"]),
        providerReference: id.optional(),
        evidence: text,
      })
      .strict()
      .parse(input);
    return this.store.transaction((s) => {
      const a = s.attempts.find((x) => x.id === attemptId);
      demand(
        a && a.state === "approved",
        "INVALID_STATE",
        "Approved attempt required",
      );
      demand(
        a.makerId === actor.id,
        "WRONG_MAKER",
        "Only designated maker may record portal result",
      );
      const o = this.order(s, a.orderId);
      this.checkCustomer(s, o.customerId);
      this.checkBeneficiary(s, o.customerId, o.quote.beneficiaryId);
      if (v.outcome === "sent") {
        demand(
          v.providerReference,
          "REFERENCE_REQUIRED",
          "Provider reference required",
        );
        demand(
          !s.attempts.some((x) => x.providerReference === v.providerReference),
          "DUPLICATE_REFERENCE",
          "Payout reference already used",
        );
        this.recordSent(s, o);
      } else o.payoutStatus = "unknown";
      Object.assign(a, {
        state: v.outcome,
        providerReference: v.providerReference,
        evidence: v.evidence,
      });
      this.audit(s, actor, "payout.recorded", o.id, {
        attemptId,
        outcome: v.outcome,
        providerReference: v.providerReference,
        evidence: v.evidence,
      });
      this.emit(s, "payout." + v.outcome, o.id);
      return a;
    });
  }
  async resolvePayout(actor: Actor, attemptId: string, input: unknown) {
    authorize(actor, "payout.resolve");
    const v = z
      .object({
        outcome: z.enum(["sent", "failed"]),
        providerReference: id.optional(),
        actualAmount: decimalString.optional(),
        paidAt: z.string().datetime({ offset: true }).optional(),
        evidence: text,
      })
      .strict()
      .parse(input);
    return this.store.transaction((s) => {
      const a = s.attempts.find((x) => x.id === attemptId);
      demand(
        a && a.state === "unknown",
        "INVALID_STATE",
        "Unknown attempt required",
      );
      demand(
        actor.role === "merchant_admin" || a.makerId !== actor.id,
        "MAKER_CHECKER",
        "Independent verification required",
      );
      if (v.outcome === "sent") {
        demand(
          v.providerReference,
          "REFERENCE_REQUIRED",
          "Provider reference required",
        );
        demand(
          !s.attempts.some(
            (x) => x.id !== a.id && x.providerReference === v.providerReference,
          ),
          "DUPLICATE_REFERENCE",
          "Reference already used",
        );
        const o = this.order(s, a.orderId);
        this.checkCustomer(s, o.customerId);
        this.checkBeneficiary(s, o.customerId, o.quote.beneficiaryId);
        if (actor.role === "merchant_admin") {
          demand(
            v.actualAmount && v.paidAt,
            "PAYMENT_DETAILS_REQUIRED",
            "Amount and payment time are required for sent resolution",
          );
          demand(
            amount(v.actualAmount, o.quote.payoutCurrency) ===
              o.quote.payoutAmount,
            "PAYOUT_AMOUNT_MISMATCH",
            "Paid amount must exactly match the order",
          );
          demand(
            Date.parse(v.paidAt) >= Date.parse(o.createdAt) &&
              Date.parse(v.paidAt) <= this.clock().getTime() + 60000,
            "INVALID_PAYMENT_TIME",
            "Payment time must be after order creation and not in the future",
          );
          o.paymentConfirmation = {
            actualAmount: amount(v.actualAmount, o.quote.payoutCurrency),
            paidAt: v.paidAt,
            providerReference: v.providerReference,
            confirmedBy: actor.id,
            verification: "admin_attestation",
          };
        }
        this.recordSent(s, o);
      } else this.order(s, a.orderId).payoutStatus = "failed";
      Object.assign(a, { state: v.outcome, verifiedBy: actor.id, ...v });
      this.audit(s, actor, "payout.verified", a.orderId, {
        attemptId,
        outcome: v.outcome,
        evidence: v.evidence,
        actualAmount: v.actualAmount,
        paidAt: v.paidAt,
        verification:
          actor.role === "merchant_admin"
            ? "admin_attestation"
            : "independent_manual_review",
      });
      return a;
    });
  }
  /** Mock bookkeeping only: the administrator attests a payment made outside this application. */
  async confirmManualPayout(actor: Actor, orderId: string, input: unknown) {
    authorize(actor, "payout.record");
    demand(
      actor.role === "merchant_admin",
      "FORBIDDEN",
      "Merchant administrator required",
    );
    const v = z
      .object({
        idempotencyKey: id,
        outcome: z.enum(["sent", "unknown"]),
        actualAmount: decimalString.optional(),
        paidAt: z.string().datetime({ offset: true }).optional(),
        providerReference: id.optional(),
        evidence: text,
      })
      .strict()
      .parse(input);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(v))
      .digest("hex");
    return this.store.transaction((s) => {
      const o = this.order(s, orderId);
      const existing = s.attempts.find(
        (a) => a.idempotencyKey === v.idempotencyKey,
      );
      if (existing) {
        const audit = s.audits.find(
          (a) =>
            a.action === "payout.admin_attested" &&
            a.data.attemptId === existing.id,
        );
        demand(
          existing.orderId === orderId &&
            audit?.data.fingerprint === fingerprint,
          "IDEMPOTENCY_CONFLICT",
          "Payment key reused with changed details",
        );
        return this.orderView(o, actor);
      }
      this.checkCustomer(s, o.customerId);
      this.checkBeneficiary(s, o.customerId, o.quote.beneficiaryId);
      demand(
        o.depositStatus === "confirmed",
        "FUNDS_NOT_READY",
        "Confirmed stablecoin deposit required",
      );
      demand(
        ["draft", "failed", "approved", "awaiting_approval"].includes(
          o.payoutStatus,
        ),
        "PAYOUT_LOCKED",
        "Sent, active or unknown payment cannot be repeated",
      );
      demand(
        !s.refunds.some((r) => r.orderId === o.id && r.kind === "principal"),
        "REFUND_CONFLICT",
        "Principal refund blocks payment",
      );
      demand(
        !s.discrepancies.some((d) => d.orderId === o.id && d.status === "open"),
        "OPEN_DISCREPANCY",
        "Resolve discrepancies before payment confirmation",
      );
      const previous = s.attempts.filter((a) => a.orderId === o.id).at(-1);
      if (o.payoutStatus === "failed")
        demand(
          previous?.state === "failed" && previous.verifiedBy,
          "VERIFY_BEFORE_RETRY",
          "Verify failed payment before retrying",
        );
      if (v.outcome === "sent") {
        demand(
          v.actualAmount && v.paidAt && v.providerReference,
          "PAYMENT_DETAILS_REQUIRED",
          "Amount, payment time and reference are required",
        );
        demand(
          amount(v.actualAmount, o.quote.payoutCurrency) ===
            o.quote.payoutAmount,
          "PAYOUT_AMOUNT_MISMATCH",
          "Paid amount must exactly match the order",
        );
        demand(
          Date.parse(v.paidAt) >= Date.parse(o.createdAt) &&
            Date.parse(v.paidAt) <= this.clock().getTime() + 60000,
          "INVALID_PAYMENT_TIME",
          "Payment time must be after order creation and not in the future",
        );
      }
      if (v.providerReference)
        demand(
          !s.attempts.some((a) => a.providerReference === v.providerReference),
          "DUPLICATE_REFERENCE",
          "Payment reference already recorded",
        );
      // Allocation is bookkeeping attestation, not an executed exchange or a bank verification.
      if (o.conversionStatus === "pending") {
        transfer(
          s,
          "conversion-source:" + o.id,
          o.quote.sourceCurrency,
          o.quote.sourceAmount,
          "liability:order:" + o.id,
          "asset:custody:mock",
          this.clock(),
        );
        transfer(
          s,
          "conversion-target:" + o.id,
          o.quote.payoutCurrency,
          o.quote.payoutAmount,
          "asset:provider:mock",
          "liability:payout:" + o.id,
          this.clock(),
        );
        o.conversionStatus = "recorded";
        o.conversion = {
          providerReference: "manual-allocation-" + o.id,
          actualRate: o.quote.customerRate,
          evidence:
            "Administrator attested manual external allocation; not bank verified",
          recordedBy: actor.id,
        };
        this.audit(s, actor, "allocation.admin_attested", o.id);
      }
      const attempt =
        previous && ["approved", "awaiting_approval"].includes(previous.state)
          ? previous
          : {
              id: randomUUID(),
              orderId,
              idempotencyKey: v.idempotencyKey,
              makerId: actor.id,
              state: v.outcome,
              createdAt: this.clock().toISOString(),
            };
      if (attempt !== previous) s.attempts.push(attempt);
      // Consume an existing legacy approved attempt instead of creating a second live payment.
      attempt.idempotencyKey = v.idempotencyKey;
      attempt.state = v.outcome;
      attempt.providerReference = v.providerReference;
      attempt.evidence = v.evidence;
      if (v.outcome === "sent") {
        this.recordSent(s, o);
        o.paymentConfirmation = {
          actualAmount: amount(v.actualAmount!, o.quote.payoutCurrency),
          paidAt: v.paidAt!,
          providerReference: v.providerReference!,
          confirmedBy: actor.id,
          verification: "admin_attestation",
        };
      } else o.payoutStatus = "unknown";
      this.audit(s, actor, "payout.admin_attested", o.id, {
        attemptId: attempt.id,
        fingerprint,
        outcome: v.outcome,
        actualAmount: v.actualAmount,
        paidAt: v.paidAt,
        providerReference: v.providerReference,
      });
      this.emit(s, "payout." + v.outcome, o.id, {
        verification: "admin_attestation",
      });
      return this.orderView(o, actor);
    });
  }
  /** Small, unscanned DEMO attachment stored in the existing mock state, never public object storage. */
  async uploadReceiptFile(actor: Actor, orderId: string, input: unknown) {
    authorize(actor, "receipt.upload");
    const v = z
      .object({
        fileName: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[^/\\\x00-\x1f]+\.(png|jpg|jpeg|pdf)$/i),
        contentType: z.enum(["image/png", "image/jpeg", "application/pdf"]),
        dataBase64: z
          .string()
          .min(4)
          .max(2796204)
          .regex(
            /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          ),
      })
      .strict()
      .parse(input);
    const bytes = Buffer.from(v.dataBase64, "base64");
    demand(
      bytes.length > 0 &&
        bytes.length <= 2 * 1024 * 1024 &&
        bytes.toString("base64") === v.dataBase64,
      "INVALID_FILE",
      "Demo attachments must be at most 2 MiB",
    );
    const valid =
      v.contentType === "image/png"
        ? bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
          /\.png$/i.test(v.fileName)
        : v.contentType === "image/jpeg"
          ? bytes.subarray(0, 3).toString("hex") === "ffd8ff" &&
            /\.jpe?g$/i.test(v.fileName)
          : bytes.subarray(0, 5).toString() === "%PDF-" &&
            /\.pdf$/i.test(v.fileName);
    demand(
      valid,
      "INVALID_FILE",
      "File signature, extension and type must match",
    );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return this.store.transaction((s) => {
      const o = this.order(s, orderId);
      demand(
        o.payoutStatus === "sent",
        "INVALID_STATE",
        "Confirm payment before attaching receipt",
      );
      o.receiptFile = {
        ...v,
        size: bytes.length,
        sha256,
        mode: "mock",
        scanStatus: "not_scanned",
      };
      o.receiptStatus = "uploaded";
      o.receipt = {
        objectKey: `receipts/${o.id}/${sha256}.${v.contentType === "application/pdf" ? "pdf" : v.contentType === "image/png" ? "png" : "jpg"}`,
        uploadedBy: actor.id,
      };
      this.audit(s, actor, "receipt.file_uploaded", o.id, {
        sha256,
        size: bytes.length,
        replaced: !!s.audits.find(
          (a) => a.targetId === o.id && a.action === "receipt.file_uploaded",
        ),
      });
      return this.orderView(o, actor);
    });
  }
  async downloadReceiptFile(actor: Actor, orderId: string) {
    const s = await this.store.read();
    const o = this.order(s, orderId);
    authorize(actor, "order.read", o.customerId);
    demand(
      o.receiptFile,
      "NOT_FOUND",
      "No demo file attached; metadata alone is not a file",
    );
    return structuredClone(o.receiptFile);
  }
  async uploadReceipt(actor: Actor, orderId: string, objectKey: string) {
    authorize(actor, "receipt.upload");
    demand(
      new RegExp(
        "^receipts/" + orderId + "/[a-zA-Z0-9_-]+\\.(pdf|png|jpg)$",
      ).test(objectKey),
      "INVALID_OBJECT_KEY",
      "Receipt must be a private, order-scoped object key",
    );
    return this.store.transaction((s) => {
      const o = this.order(s, orderId);
      demand(
        o.payoutStatus === "sent",
        "INVALID_STATE",
        "Receipt may be attached after payout is sent",
      );
      demand(
        !o.receiptFile,
        "RECEIPT_FILE_EXISTS",
        "Replace an attached file through the receipt-file endpoint, not metadata",
      );
      o.receiptStatus = "uploaded";
      o.receipt = { objectKey, uploadedBy: actor.id };
      this.audit(s, actor, "receipt.uploaded", o.id, { objectKey });
      return this.orderView(o, actor);
    });
  }
  async reconcile(actor: Actor, orderId: string, input: unknown) {
    authorize(actor, "reconcile");
    const v = z
      .object({
        providerReference: id,
        actualAmount: decimalString,
        evidence: text,
      })
      .strict()
      .parse(input);
    return this.store.transaction((s) => {
      const o = this.order(s, orderId);
      demand(
        o.payoutStatus === "sent",
        "INVALID_STATE",
        "Sent payout required",
      );
      const attempt = s.attempts.find(
        (a) => a.orderId === o.id && a.state === "sent",
      );
      demand(
        attempt &&
          (actor.role === "merchant_admin" || attempt.makerId !== actor.id),
        "MAKER_CHECKER",
        "Independent financial verification required",
      );
      if (
        v.providerReference !== attempt.providerReference ||
        amount(v.actualAmount, o.quote.payoutCurrency) !== o.quote.payoutAmount
      ) {
        const d = {
          id: randomUUID(),
          orderId,
          kind: "payout_mismatch",
          detail: "Provider amount or reference differs from order.",
          status: "open" as const,
        };
        s.discrepancies.push(d);
        o.reconciled = false;
        this.audit(s, actor, "reconciliation.mismatch", o.id);
        return { matched: false, discrepancy: d };
      }
      demand(
        !s.discrepancies.some((d) => d.orderId === o.id && d.status === "open"),
        "OPEN_DISCREPANCY",
        "Resolve open discrepancies with evidence before marking reconciled",
      );
      o.reconciled = true;
      if (o.receipt && actor.role !== "merchant_admin")
        o.receiptStatus = "verified";
      attempt.verifiedBy = actor.id;
      this.audit(s, actor, "reconciliation.matched", o.id, {
        evidence: v.evidence,
      });
      this.accrueCommission(s, o);
      return { matched: true, orderId };
    });
  }
  private accrueCommission(s: State, o: Order) {
    if (
      !o.quote.partnerId ||
      s.commissions.some((c) => c.orderId === o.id && !c.originalCommissionId)
    )
      return;
    const refunded = s.refunds
      .filter(
        (r) =>
          r.orderId === o.id &&
          r.kind === "service_fee" &&
          r.status === "recorded",
      )
      .reduce((sum, r) => sum + units(r.amount, 6), 0n);
    const base = decimal(units(o.quote.serviceFee, 6) - refunded, 6);
    const value = proportion(
      base,
      o.quote.sourceCurrency,
      o.quote.commissionRate,
    );
    if (units(value, 6) === 0n) return;
    const c: Commission = {
      id: randomUUID(),
      orderId: o.id,
      partnerId: o.quote.partnerId,
      currency: o.quote.sourceCurrency,
      base,
      rate: o.quote.commissionRate,
      value,
      ruleVersion: o.quote.commissionRuleVersion,
      attributionVersion: o.quote.attributionVersion!,
      eligibleAt: new Date(
        this.clock().getTime() + this.config.commissionHoldDays * 86400000,
      ).toISOString(),
      state: "available",
    };
    s.commissions.push(c);
    transfer(
      s,
      "commission:" + c.id,
      c.currency,
      value,
      "expense:partner-commission",
      "liability:partner:" + c.partnerId,
      this.clock(),
    );
  }
  async resolveDiscrepancy(
    actor: Actor,
    discrepancyId: string,
    evidence: string,
  ) {
    authorize(actor, "discrepancy.resolve");
    text.parse(evidence);
    return this.store.transaction((s) => {
      const d = s.discrepancies.find((x) => x.id === discrepancyId);
      demand(
        d && d.status === "open",
        "INVALID_STATE",
        "Open discrepancy required",
      );
      demand(
        d.kind !== "deposit_mismatch",
        "MANUAL_ADJUSTMENT_REQUIRED",
        "Unallocated deposits require a reviewed allocation/refund flow not implemented in this mock MVP",
      );
      Object.assign(d, { status: "resolved", evidence, resolvedBy: actor.id });
      this.audit(s, actor, "discrepancy.resolved", d.id, { evidence });
      return d;
    });
  }
  async requestRefund(actor: Actor, orderId: string, input: unknown) {
    authorize(actor, "refund.request");
    const v = z
      .object({
        idempotencyKey: id,
        kind: z.enum(["principal", "service_fee"]),
        amount: decimalString,
      })
      .strict()
      .parse(input);
    return this.store.transaction((s) => {
      const o = this.order(s, orderId);
      const existing = s.refunds.find(
        (r) => r.idempotencyKey === v.idempotencyKey,
      );
      if (existing) {
        demand(
          existing.orderId === orderId &&
            existing.kind === v.kind &&
            existing.amount === amount(v.amount, existing.currency),
          "IDEMPOTENCY_CONFLICT",
          "Refund key reused with different request",
        );
        return existing;
      }
      demand(
        o.depositStatus === "confirmed",
        "FUNDS_NOT_READY",
        "Confirmed deposit required",
      );
      if (v.kind === "principal")
        demand(
          o.conversionStatus === "pending" &&
            ["draft", "cancelled"].includes(o.payoutStatus),
          "REFUND_CONFLICT",
          "Principal refunds are supported only before external conversion",
        );
      else
        demand(
          o.payoutStatus === "sent",
          "REFUND_CONFLICT",
          "Service fee refund requires sent payout",
        );
      const value = amount(v.amount, o.quote.sourceCurrency);
      const reserved = s.refunds
        .filter((r) => r.orderId === o.id && r.kind === v.kind)
        .reduce((sum, r) => sum + units(r.amount, 6), 0n);
      demand(
        units(value, 6) > 0n &&
          reserved + units(value, 6) <=
            units(
              v.kind === "principal"
                ? o.quote.sourceAmount
                : o.quote.serviceFee,
              6,
            ),
        "REFUND_LIMIT",
        "Refund exceeds unrefunded amount",
      );
      const r = {
        id: randomUUID(),
        orderId,
        idempotencyKey: v.idempotencyKey,
        kind: v.kind,
        amount: value,
        currency: o.quote.sourceCurrency,
        status: "requested" as const,
        makerId: actor.id,
      };
      s.refunds.push(r);
      if (v.kind === "principal") o.payoutStatus = "cancelled";
      this.audit(s, actor, "refund.requested", r.id);
      return r;
    });
  }
  async approveRefund(actor: Actor, refundId: string) {
    authorize(actor, "refund.approve");
    return this.store.transaction((s) => {
      const r = s.refunds.find((x) => x.id === refundId);
      demand(
        r && r.status === "requested",
        "INVALID_STATE",
        "Requested refund required",
      );
      demand(
        actor.role === "merchant_admin" || r.makerId !== actor.id,
        "MAKER_CHECKER",
        "Maker cannot approve refund",
      );
      r.status = "approved";
      r.checkerId = actor.id;
      this.audit(s, actor, "refund.approved", r.id);
      return r;
    });
  }
  async recordRefund(actor: Actor, refundId: string, input: unknown) {
    authorize(actor, "refund.record");
    const v = z
      .object({ providerReference: id, evidence: text })
      .strict()
      .parse(input);
    return this.store.transaction((s) => {
      const r = s.refunds.find((x) => x.id === refundId);
      demand(r, "NOT_FOUND", "Refund missing");
      if (r.status === "recorded") {
        demand(
          r.providerReference === v.providerReference,
          "IDEMPOTENCY_CONFLICT",
          "Refund was already recorded",
        );
        return r;
      }
      demand(
        r.status === "approved" && r.makerId === actor.id,
        "INVALID_STATE",
        "Approved refund and designated maker required",
      );
      demand(
        !s.refunds.some((x) => x.providerReference === v.providerReference),
        "DUPLICATE_REFERENCE",
        "Refund provider reference already used",
      );
      r.status = "recorded";
      r.providerReference = v.providerReference;
      r.evidence = v.evidence;
      transfer(
        s,
        "refund:" + r.id,
        r.currency,
        r.amount,
        r.kind === "principal"
          ? "liability:order:" + r.orderId
          : "revenue:service-fee",
        "asset:custody:mock",
        this.clock(),
      );
      if (r.kind === "service_fee") {
        const original = s.commissions.find(
          (c) => c.orderId === r.orderId && !c.originalCommissionId,
        );
        if (original) {
          const refundedTotal = s.refunds
            .filter(
              (x) =>
                x.orderId === r.orderId &&
                x.kind === "service_fee" &&
                x.status === "recorded",
            )
            .reduce((sum, x) => sum + units(x.amount, 6), 0n);
          const remainingBase =
            units(this.order(s, r.orderId).quote.serviceFee, 6) - refundedTotal;
          const targetRemaining = units(
            proportion(decimal(remainingBase, 6), r.currency, original.rate),
            6,
          );
          const alreadyReversed = s.commissions
            .filter((c) => c.originalCommissionId === original.id)
            .reduce((sum, c) => sum + units(c.value.slice(1), 6), 0n);
          const negative = decimal(
            units(original.value, 6) - targetRemaining - alreadyReversed,
            6,
          );
          if (units(negative, 6) > 0n) {
            const c: Commission = {
              ...original,
              id: randomUUID(),
              base: r.amount,
              value: "-" + negative,
              state: "adjustment",
              originalCommissionId: original.id,
              refundId: r.id,
              eligibleAt: this.clock().toISOString(),
              settlementId: undefined,
            };
            s.commissions.push(c);
            transfer(
              s,
              "commission-refund:" + r.id,
              r.currency,
              negative,
              "liability:partner:" + original.partnerId,
              "expense:partner-commission",
              this.clock(),
            );
          }
        }
      }
      this.audit(s, actor, "refund.recorded", r.id, {
        providerReference: v.providerReference,
        evidence: v.evidence,
      });
      return r;
    });
  }
  async createSettlement(actor: Actor, input: unknown) {
    authorize(actor, "settlement.create");
    const v = z
      .object({
        partnerId: id,
        month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
        currency: z.enum(["USDT", "USDC"]),
      })
      .strict()
      .parse(input);
    return this.store.transaction((s) => {
      demand(
        v.month < this.clock().toISOString().slice(0, 7),
        "OPEN_MONTH",
        "Only closed calendar months can be settled",
      );
      const old = s.settlements.find(
        (x) =>
          x.partnerId === v.partnerId &&
          x.month === v.month &&
          x.currency === v.currency &&
          x.status !== "cancelled",
      );
      if (old) return old;
      const eligible = s.commissions.filter(
        (c) =>
          c.partnerId === v.partnerId &&
          c.currency === v.currency &&
          !c.settlementId &&
          Date.parse(c.eligibleAt) <= this.clock().getTime() &&
          (c.eligibleAt.slice(0, 7) <= v.month ||
            (!!c.originalCommissionId &&
              s.commissions.some(
                (original) =>
                  original.id === c.originalCommissionId &&
                  original.eligibleAt.slice(0, 7) <= v.month,
              ))) &&
          this.order(s, c.orderId).reconciled &&
          !s.discrepancies.some(
            (d) => d.orderId === c.orderId && d.status === "open",
          ),
      );
      const total = eligible.reduce(
        (sum, c) =>
          sum +
          (c.value.startsWith("-")
            ? -units(c.value.slice(1), 6)
            : units(c.value, 6)),
        0n,
      );
      demand(
        total > 0n,
        "NO_PAYABLE_COMMISSION",
        "No positive eligible balance; negative adjustments carry forward",
      );
      const st = {
        id: randomUUID(),
        ...v,
        commissionIds: eligible.map((c) => c.id),
        amount: decimal(total, 6),
        status: "draft" as const,
        makerId: actor.id,
      };
      s.settlements.push(st);
      eligible.forEach((c) => (c.settlementId = st.id));
      this.audit(s, actor, "settlement.created", st.id);
      return st;
    });
  }
  async approveSettlement(actor: Actor, settlementId: string) {
    authorize(actor, "settlement.approve");
    return this.store.transaction((s) => {
      const st = s.settlements.find((x) => x.id === settlementId);
      demand(
        st && st.status === "draft",
        "INVALID_STATE",
        "Draft settlement required",
      );
      demand(
        actor.role === "merchant_admin" || st.makerId !== actor.id,
        "MAKER_CHECKER",
        "Independent settlement checker required",
      );
      for (const cid of st.commissionIds) {
        const c = s.commissions.find((x) => x.id === cid)!;
        demand(
          this.order(s, c.orderId).reconciled &&
            !s.discrepancies.some(
              (d) => d.orderId === c.orderId && d.status === "open",
            ),
          "SETTLEMENT_BLOCKED",
          "Commission order no longer reconciled",
        );
      }
      demand(
        !s.commissions.some(
          (c) =>
            c.originalCommissionId &&
            st.commissionIds.includes(c.originalCommissionId) &&
            !st.commissionIds.includes(c.id),
        ),
        "SETTLEMENT_STALE",
        "A refund adjusted this draft. Cancel/rebuild via reviewed workflow before approval.",
      );
      st.status = "approved";
      st.checkerId = actor.id;
      this.audit(s, actor, "settlement.approved", st.id);
      return st;
    });
  }
  async cancelSettlement(actor: Actor, settlementId: string, reason: string) {
    authorize(actor, "settlement.cancel");
    text.parse(reason);
    return this.store.transaction((s) => {
      const st = s.settlements.find((x) => x.id === settlementId);
      demand(
        st && st.status === "draft",
        "INVALID_STATE",
        "Only an unapproved draft can be cancelled",
      );
      st.status = "cancelled";
      for (const commission of s.commissions.filter(
        (c) => c.settlementId === st.id,
      ))
        commission.settlementId = undefined;
      this.audit(s, actor, "settlement.cancelled", st.id, { reason });
      this.emit(s, "settlement.cancelled", st.id);
      return st;
    });
  }
  async importBatch(
    actor: Actor,
    customerId: string,
    clientBatchId: string,
    csv: string,
  ) {
    authorize(actor, "batch.create", customerId);
    id.parse(clientBatchId);
    demand(Buffer.byteLength(csv) <= 100000, "CSV_SIZE", "CSV max 100KB");
    const rows = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      bom: true,
      trim: true,
      relax_column_count: false,
    }) as Record<string, string>[];
    demand(
      rows.length > 0 && rows.length <= 100,
      "BATCH_SIZE",
      "Batch must have 1–100 rows",
    );
    demand(
      Object.keys(rows[0]).sort().join(",") ===
        "beneficiaryId,clientItemId,sourceAmount,sourceCurrency",
      "CSV_COLUMNS",
      "Columns: clientItemId,beneficiaryId,sourceCurrency,sourceAmount",
    );
    return this.store.transaction((s) => {
      this.checkCustomer(s, customerId);
      demand(
        !s.batches.some(
          (b) =>
            b.customerId === customerId && b.clientBatchId === clientBatchId,
        ),
        "DUPLICATE_BATCH",
        "Batch key already imported",
      );
      const batch = {
        id: randomUUID(),
        customerId,
        clientBatchId,
        itemIds: [] as string[],
        createdAt: this.clock().toISOString(),
      };
      const seen = new Set<string>();
      rows.forEach((row) => {
        const errors: string[] = [];
        if (Object.values(row).some((v) => /^[\s\u0000-\u001f]*[=+@-]/.test(v)))
          errors.push("Spreadsheet formula prefix rejected");
        const parsed = z
          .object({
            clientItemId: id,
            beneficiaryId: id,
            sourceAmount: decimalString,
            sourceCurrency: z.enum(["USDT", "USDC"]),
          })
          .strict()
          .safeParse(row);
        if (!parsed.success) errors.push("Invalid row fields");
        if (seen.has(row.clientItemId)) errors.push("Duplicate clientItemId");
        if (
          s.batchItems.some(
            (i) =>
              i.clientItemId === row.clientItemId &&
              i.status !== "error" &&
              s.batches.some(
                (b) => b.id === i.batchId && b.customerId === customerId,
              ),
          )
        )
          errors.push("Client item already imported for this customer");
        seen.add(row.clientItemId);
        if (
          !s.beneficiaries.some(
            (b) =>
              b.id === row.beneficiaryId &&
              b.customerId === customerId &&
              b.status === "approved",
          )
        )
          errors.push("Beneficiary not whitelisted");
        try {
          demand(
            units(row.sourceAmount, 6) > 0n,
            "INVALID_AMOUNT",
            "Positive amount required",
          );
        } catch {
          errors.push("Invalid amount precision or value");
        }
        const item = {
          id: randomUUID(),
          batchId: batch.id,
          clientItemId: row.clientItemId,
          beneficiaryId: row.beneficiaryId,
          sourceAmount: row.sourceAmount,
          sourceCurrency: row.sourceCurrency as "USDT" | "USDC",
          status: errors.length ? ("error" as const) : ("valid" as const),
          errors,
        };
        s.batchItems.push(item);
        batch.itemIds.push(item.id);
      });
      s.batches.push(batch);
      this.audit(s, actor, "batch.imported", batch.id, {
        rowCount: rows.length,
      });
      return {
        batch,
        items: s.batchItems.filter((i) => i.batchId === batch.id),
      };
    });
  }
  async submitBatch(actor: Actor, batchId: string) {
    return this.store.transaction((s) => {
      const batch = s.batches.find((b) => b.id === batchId);
      demand(batch, "NOT_FOUND", "Batch missing");
      authorize(actor, "batch.create", batch.customerId);
      for (const item of s.batchItems.filter(
        (i) => i.batchId === batchId && i.status === "valid",
      )) {
        const q = this.quote(s, {
          customerId: batch.customerId,
          beneficiaryId: item.beneficiaryId,
          sourceCurrency: item.sourceCurrency,
          sourceAmount: item.sourceAmount,
        });
        const o = this.makeOrder(
          s,
          actor,
          q.id,
          `batch_${batchId}_${item.clientItemId}`,
          batchId,
        );
        item.orderId = o.id;
        item.status = "created";
      }
      return {
        batch,
        items: s.batchItems.filter((i) => i.batchId === batchId),
      };
    });
  }
  private quoteView(q: Quote, actor: Actor) {
    const result = structuredClone(q) as Partial<Quote>;
    if (actor.role === "customer") {
      delete result.costRate;
      delete result.referenceRate;
      delete result.commissionRate;
      delete result.commissionRuleVersion;
      delete result.attributionVersion;
      delete result.partnerId;
    }
    return result;
  }
  private orderView(o: Order, actor: Actor) {
    const view = {
      ...structuredClone(o),
      quote: this.quoteView(o.quote, actor),
    } as Record<string, unknown>;
    view.receiptFileAvailable = !!o.receiptFile;
    delete view.receiptFile;
    if (actor.role === "customer") {
      delete view.conversion;
      if (o.receipt) view.receipt = { available: true };
    }
    return view;
  }
  async dashboard(actor: Actor) {
    const s = await this.store.read();
    const eligibility = (
      c: Commission,
    ): "hold" | "available" | "allocated" | "frozen" => {
      if (c.settlementId) return "allocated";
      if (
        !this.order(s, c.orderId).reconciled ||
        s.discrepancies.some(
          (d) => d.orderId === c.orderId && d.status === "open",
        )
      )
        return "frozen";
      return Date.parse(c.eligibleAt) > this.clock().getTime()
        ? "hold"
        : "available";
    };
    if (actor.role === "partner") {
      authorize(actor, "commission.read");
      demand(actor.partnerId, "FORBIDDEN", "Partner scope required");
      return {
        mode: "MOCK",
        commissions: s.commissions
          .filter((c) => c.partnerId === actor.partnerId)
          .map((c) => ({
            id: c.id,
            customerAlias:
              "客户-" +
              createHash("sha256")
                .update(this.order(s, c.orderId).customerId)
                .digest("hex")
                .slice(0, 6),
            currency: c.currency,
            base: c.base,
            rate: c.rate,
            value: c.value,
            state: c.state,
            eligibleAt: c.eligibleAt,
            eligibility: eligibility(c),
            settlementId: c.settlementId,
          })),
        settlements: s.settlements.filter(
          (x) => x.partnerId === actor.partnerId,
        ),
      };
    }
    authorize(actor, "order.read", actor.customerId);
    const customer = actor.role === "customer";
    return {
      mode: "MOCK",
      actor,
      pricingFixture: customer ? undefined : this.config,
      commissions: ["merchant_admin", "finance", "auditor"].includes(actor.role)
        ? s.commissions.map((c) => ({ ...c, eligibility: eligibility(c) }))
        : undefined,
      settlements: ["merchant_admin", "finance", "auditor"].includes(actor.role)
        ? s.settlements
        : undefined,
      batches: s.batches.filter(
        (b) => !customer || b.customerId === actor.customerId,
      ),
      batchItems: s.batchItems.filter((i) =>
        s.batches.some(
          (b) =>
            b.id === i.batchId &&
            (!customer || b.customerId === actor.customerId),
        ),
      ),
      customers: customer
        ? s.customers
            .filter((c) => c.id === actor.customerId)
            .map((c) => ({
              id: c.id,
              kind: c.kind,
              name: c.name,
              status: c.status,
            }))
        : s.customers,
      beneficiaries: s.beneficiaries
        .filter((b) => !customer || b.customerId === actor.customerId)
        .map(({ accountToken, ...b }) => b),
      orders: s.orders
        .filter((o) => !customer || o.customerId === actor.customerId)
        .map((o) => this.orderView(o, actor)),
      attempts: customer
        ? undefined
        : s.attempts.map(({ evidence, ...a }) => a),
      discrepancies: customer
        ? undefined
        : s.discrepancies.map(({ evidence, ...d }) => d),
      refunds: s.refunds
        .filter(
          (r) =>
            !customer ||
            this.order(s, r.orderId).customerId === actor.customerId,
        )
        .map(({ evidence, ...r }) => r),
    };
  }
  async auditTrail(actor: Actor) {
    authorize(actor, "audit.read");
    return (await this.store.read()).audits;
  }
}
