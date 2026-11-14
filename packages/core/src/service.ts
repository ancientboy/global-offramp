import { encodeReceipt, decodeReceipt } from "./receipt-storage";
import { validateMerchantRow } from "./merchant-import";
import { ReceiptService } from "./receipts";
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
  FIAT_CODES,
  countryMatchesCurrency,
  defaultPayoutCountry,
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
import {
  calculatePricing,
  checkBaseline,
  initialPricing,
  initialProviders,
  pricingInput,
  providerInput,
} from "./pricing";
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
    payoutCurrency: z.enum(FIAT_CODES).optional(),
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
// Saved means schema-valid synthetic details, not bank or identity verification.
// Legacy pending records were already schema-valid and need no manual review.
const usableBeneficiary = (b: Beneficiary | undefined): b is Beneficiary =>
  !!b && ["saved", "approved", "pending"].includes(b.status);

export class OfframpService {
  private readonly bootstrapPricing;
  constructor(
    public readonly store: Store,
    private readonly clock: () => Date = () => new Date(),
    private readonly config: typeof CONFIG = CONFIG,
    private readonly fundsMode: "mock" | "live" = "mock",
  ) {
    this.bootstrapPricing = initialPricing(config, clock());
  }
  private currentPricing(s: State) {
    return s.pricingHistory?.at(-1) ?? this.bootstrapPricing;
  }
  private ensurePricing(s: State) {
    if (!s.pricingHistory?.length)
      s.pricingHistory = [structuredClone(this.bootstrapPricing)];
  }
  async previewPricing(actor: Actor, input: unknown) {
    authorize(actor, "payout.record");
    demand(
      actor.role === "merchant_admin",
      "FORBIDDEN",
      "Merchant administrator required",
    );
    const v = pricingInput.parse(input);
    const current = this.currentPricing(await this.store.read());
    demand(
      v.expectedVersion === current.version,
      "PRICING_VERSION_CONFLICT",
      "Pricing changed; reload before previewing",
    );
    return calculatePricing(v, this.clock(), "preview");
  }
  async publishPricing(
    actor: Actor,
    input: unknown,
    marketReference?: import("./types").PricingVersion["marketReference"],
  ) {
    authorize(actor, "payout.record");
    demand(
      actor.role === "merchant_admin",
      "FORBIDDEN",
      "Merchant administrator required",
    );
    const v = pricingInput.parse(input);
    return this.store.transaction((s) => {
      this.ensurePricing(s);
      demand(
        v.expectedVersion === this.currentPricing(s).version,
        "PRICING_VERSION_CONFLICT",
        "Pricing changed; review the latest version",
      );
      const p = calculatePricing(
        v,
        this.clock(),
        "mock-pricing-" + randomUUID(),
      );
      p.publishedAt = this.clock().toISOString();
      p.publishedBy = actor.id;
      const current = this.currentPricing(s);
      const sameBaseline = Object.entries(p.baseline).every(
        ([key, value]) =>
          current.baseline[key as keyof typeof p.baseline] === value,
      );
      if (marketReference) {
        demand(
          marketReference.fetchedAt === p.baseline.asOf,
          "INVALID_REFERENCE",
          "Reference timestamp mismatch",
        );
        p.marketReference = structuredClone(marketReference);
      } else if (sameBaseline && current.marketReference) {
        p.marketReference = structuredClone(current.marketReference);
      }
      (s.pricingHistory ??= []).push(p);
      this.audit(s, actor, "pricing.published", p.version, {
        previousVersion: v.expectedVersion,
      });
      return p;
    });
  }
  async upsertPayoutProvider(actor: Actor, input: unknown) {
    authorize(actor, "payout.record");
    demand(
      actor.role === "merchant_admin",
      "FORBIDDEN",
      "Merchant administrator required",
    );
    const v = providerInput.parse(input);
    demand(
      new Set(v.routes).size === v.routes.length,
      "INVALID_PROVIDER_ROUTE",
      "Duplicate provider routes",
    );
    demand(
      !v.isDefault || v.status === "active",
      "INVALID_PROVIDER_STATUS",
      "Default provider must be active",
    );
    return this.store.transaction((s) => {
      const providers = (s.payoutProviders ??= initialProviders());
      const existing = v.id ? providers.find((p) => p.id === v.id) : undefined;
      demand(!v.id || existing, "NOT_FOUND", "Payout provider missing");
      const p = {
        ...v,
        id: existing?.id ?? randomUUID(),
        updatedAt: this.clock().toISOString(),
      };
      if (v.isDefault)
        for (const other of providers)
          if (
            other.id !== p.id &&
            other.routes.some((r) => p.routes.includes(r))
          )
            other.isDefault = false;
      if (existing) providers[providers.indexOf(existing)] = p;
      else providers.push(p);
      for (const currency of FIAT_CODES.filter(
        (c) => this.currentPricing(s).routes[c]?.enabled,
      ))
        demand(
          providers.filter(
            (x) =>
              x.isDefault &&
              x.status === "active" &&
              x.routes.includes(currency),
          ).length === 1,
          "DEFAULT_PROVIDER_REQUIRED",
          "Every route requires exactly one active default payout provider",
        );
      this.audit(s, actor, "payout_provider.updated", p.id, {
        scope: p.scope,
        status: p.status,
        routes: p.routes,
        isDefault: p.isDefault,
      });
      return p;
    });
  }
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
      usableBeneficiary(b),
      "BENEFICIARY_BLOCKED",
      "Available recipient belonging to this customer required",
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
    this.ensurePricing(s);
    const pricing = this.currentPricing(s);
    checkBaseline(pricing, this.clock());
    const rateRow = pricing.rates.find(
      (r) =>
        r.sourceCurrency === input.sourceCurrency &&
        r.payoutCurrency === beneficiary.currency,
    )!;
    demand(rateRow, "ROUTE_DISABLED", "Currency reference is not configured");
    const route = {
      ...this.config.routes[beneficiary.currency],
      ...pricing.routes[beneficiary.currency],
      ...rateRow,
    };
    demand(
      route.enabled &&
        countryMatchesCurrency(beneficiary.currency, beneficiary.country),
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
      customer.serviceFeeOverride ?? pricing.serviceFee,
      input.sourceCurrency,
    );
    const channelFee = amount(pricing.channelFee, input.sourceCurrency);
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
      configVersion: pricing.version,
      feeRuleVersion: pricing.version,
      pricingSnapshot: structuredClone(pricing),
      partnerId: customer.partnerId,
      attributionVersion: customer.attributionVersion,
      commissionRate: customer.partnerId
        ? this.config.commissionRate
        : "0.00000000",
      commissionRuleVersion: this.config.commissionRuleVersion,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        Math.min(
          now.getTime() + this.config.quoteTtlSeconds * 1000,
          Date.parse(pricing.baseline.expiresAt),
        ),
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
        name: z.string().trim().min(1).max(100),
        country: z.string().regex(/^[A-Z]{2}$/),
        currency: z.enum(FIAT_CODES),
        accountToken: id,
        accountMasked: z.string().regex(/^\*{4} (?:\d{4}|PIX)$/),
        bankName: z.string().trim().min(1).max(100).optional(),
        recipientAccount: z
          .object({
            method: z.enum([
              "CN_BANK_ACCOUNT",
              "US_BANK_ACCOUNT",
              "EUR_IBAN",
              "MX_CLABE",
              "BR_BANK_ACCOUNT",
              "BR_PIX",
              "GB_LOCAL_ACCOUNT",
              "GB_IBAN",
            ]),
            encrypted: z
              .string()
              .regex(/^v1\.[A-Za-z0-9_.-]+$/)
              .max(20000),
            boundAt: z.string().datetime(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(input);
    authorize(actor, "beneficiary.create", v.customerId);
    return this.store.transaction((s) => {
      this.checkCustomer(s, v.customerId);
      demand(
        countryMatchesCurrency(v.currency, v.country),
        "ROUTE_MISMATCH",
        "Country and currency mismatch",
      );
      const b: Beneficiary = {
        id: randomUUID(),
        ...v,
        status: "saved",
        createdBy: actor.id,
      };
      s.beneficiaries.push(b);
      this.audit(s, actor, "beneficiary.saved", b.id, {
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
  private walletAccount(customerId: string) {
    return "liability:wallet:" + customerId;
  }
  private walletAvailable(
    s: State,
    customerId: string,
    currency: "USDT" | "USDC",
  ) {
    return s.journals
      .flatMap((j) => j.lines)
      .filter(
        (l) =>
          l.account === this.walletAccount(customerId) &&
          l.currency === currency,
      )
      .reduce((n, l) => n + units(l.credit, 6) - units(l.debit, 6), 0n);
  }
  /** Synthetic credit only. There is no address, external transfer, or custody integration. */
  async depositWallet(actor: Actor, input: unknown) {
    demand(
      this.fundsMode !== "live",
      "SIMULATED_TOPUPS_DISABLED",
      "Synthetic credits cannot enter a live ledger",
    );
    const v = z
      .object({
        customerId: id,
        currency: z.enum(["USDT", "USDC"]),
        amount: decimalString,
        idempotencyKey: id,
      })
      .strict()
      .parse(input);
    authorize(actor, "wallet.deposit", v.customerId);
    const value = amount(v.amount, v.currency);
    demand(units(value, 6) > 0n, "INVALID_AMOUNT", "Deposit must be positive");
    return this.store.transaction((s) => {
      this.checkCustomer(s, v.customerId);
      const key = "wallet-deposit:" + v.customerId + ":" + v.idempotencyKey;
      const duplicate = s.journals.some((j) => j.businessKey === key);
      const journal = transfer(
        s,
        key,
        v.currency,
        value,
        "asset:custody:mock",
        this.walletAccount(v.customerId),
        this.clock(),
      );
      if (!duplicate) {
        this.audit(s, actor, "wallet.deposited", journal.id, {
          customerId: v.customerId,
          currency: v.currency,
          amount: value,
          idempotencyKey: v.idempotencyKey,
          mode: "MOCK",
        });
        this.emit(s, "wallet.deposited", journal.id, {
          customerId: v.customerId,
          currency: v.currency,
          amount: value,
        });
      }
      return {
        mode: "MOCK",
        duplicate,
        journalId: journal.id,
        customerId: v.customerId,
        currency: v.currency,
        amount: value,
        available: decimal(
          this.walletAvailable(s, v.customerId, v.currency),
          6,
        ),
      };
    });
  }
  private releaseWallet(s: State, actor: Actor, o: Order, reason: string) {
    if (o.fundingSource !== "wallet" || o.walletFundingStatus === "released")
      return;
    demand(
      o.walletFundingStatus === "reserved",
      "WALLET_LOCKED",
      "Consumed funds cannot be released",
    );
    demand(
      o.conversionStatus === "pending",
      "FUNDS_CONVERTED",
      "Converted funds need treasury resolution, not automatic stablecoin credit",
    );
    transfer(
      s,
      "wallet-release:" + o.id,
      o.quote.sourceCurrency,
      o.quote.totalDeposit,
      "liability:order:" + o.id,
      this.walletAccount(o.customerId),
      this.clock(),
    );
    o.walletFundingStatus = "released";
    this.audit(s, actor, "wallet.released", o.id, {
      customerId: o.customerId,
      currency: o.quote.sourceCurrency,
      amount: o.quote.totalDeposit,
      reason,
    });
    this.emit(s, "wallet.released", o.id);
  }
  async cancelOrder(actor: Actor, orderId: string, input: unknown) {
    const { reason } = z.object({ reason: text }).strict().parse(input);
    return this.store.transaction((s) => {
      const o = this.order(s, orderId);
      authorize(actor, "order.cancel", o.customerId);
      demand(
        o.fundingSource === "wallet",
        "WALLET_REQUIRED",
        "Use legacy refund handling for deposit-funded orders",
      );
      if (
        o.payoutStatus === "cancelled" &&
        o.walletFundingStatus === "released"
      )
        return this.orderView(o, actor);
      demand(
        o.payoutStatus === "draft" &&
          o.conversionStatus === "pending" &&
          !s.attempts.some((a) => a.orderId === o.id),
        "PAYOUT_LOCKED",
        "Only an untouched wallet order can be cancelled; verify active or unknown payments first",
      );
      this.releaseWallet(s, actor, o, reason);
      o.payoutStatus = "cancelled";
      this.audit(s, actor, "order.cancelled", o.id, { reason });
      return this.orderView(o, actor);
    });
  }
  private requireWalletReservation(o: Order) {
    demand(
      o.fundingSource !== "wallet" || o.walletFundingStatus === "reserved",
      "WALLET_RELEASED",
      "Wallet reservation closed; create a new quote and order",
    );
  }
  private makeOrder(
    s: State,
    actor: Actor,
    quoteId: string,
    clientOrderId: string,
    batchId?: string,
    fundingSource: "deposit" | "wallet" = "deposit",
  ) {
    const q = s.quotes.find((x) => x.id === quoteId);
    demand(q, "NOT_FOUND", "Quote missing");
    authorize(actor, "order.create", q.customerId);
    const existing = s.orders.find(
      (x) => x.customerId === q.customerId && x.clientOrderId === clientOrderId,
    );
    if (existing) {
      demand(
        existing.quote.id === quoteId &&
          (existing.fundingSource ?? "deposit") === fundingSource,
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
    const provider = (s.payoutProviders ?? initialProviders()).find(
      (p) =>
        p.status === "active" &&
        p.isDefault &&
        p.routes.includes(q.payoutCurrency),
    );
    demand(
      provider,
      "PROVIDER_UNAVAILABLE",
      "No active default payout provider for this route",
    );
    const order: Order = {
      id: randomUUID(),
      orderNumber:
        "MOCK-" +
        this.clock().toISOString().slice(0, 10).replaceAll("-", "") +
        "-" +
        String(s.orders.length + 1).padStart(6, "0"),
      payoutProviderSnapshot: structuredClone(provider),
      customerId: q.customerId,
      quote: structuredClone(q),
      clientOrderId,
      fundingSource,
      ...(fundingSource === "wallet"
        ? { walletFundingStatus: "reserved" as const }
        : {}),
      depositStatus: fundingSource === "wallet" ? "confirmed" : "awaiting",
      conversionStatus: "pending",
      payoutStatus: "draft",
      receiptStatus: "none",
      reconciled: false,
      createdAt: this.clock().toISOString(),
      ...(batchId ? { batchId } : {}),
    };
    if (fundingSource === "deposit") {
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
    } else {
      demand(
        this.walletAvailable(s, q.customerId, q.sourceCurrency) >=
          units(q.totalDeposit, 6),
        "INSUFFICIENT_BALANCE",
        "Insufficient available wallet balance including fees",
      );
      transfer(
        s,
        "wallet-reserve:" + order.id,
        q.sourceCurrency,
        q.totalDeposit,
        this.walletAccount(q.customerId),
        "liability:order:" + order.id,
        this.clock(),
      );
      this.audit(s, actor, "wallet.reserved", order.id, {
        customerId: q.customerId,
        currency: q.sourceCurrency,
        amount: q.totalDeposit,
      });
    }
    s.orders.push(order);
    this.audit(s, actor, "order.created", order.id);
    this.emit(s, "order.created", order.id);
    return order;
  }
  async createOrder(actor: Actor, input: unknown) {
    const v = z
      .object({
        quoteId: id,
        clientOrderId: id,
        fundingSource: z.enum(["deposit", "wallet"]).optional(),
      })
      .strict()
      .parse(input);
    return this.store.transaction((s) =>
      this.orderView(
        this.makeOrder(
          s,
          actor,
          v.quoteId,
          v.clientOrderId,
          undefined,
          v.fundingSource,
        ),
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
        o.fundingSource !== "wallet",
        "WALLET_FUNDED",
        "Wallet orders cannot receive a second order deposit",
      );
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
      this.requireWalletReservation(o);
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
      this.requireWalletReservation(o);
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
      this.requireWalletReservation(o);
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
        this.fundsMode === "live"
          ? "asset:provider:attested:" +
              (o.payoutProviderSnapshot?.id ?? "unassigned")
          : "asset:provider:mock",
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
    if (o.fundingSource === "wallet") o.walletFundingStatus = "consumed";
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
      this.requireWalletReservation(o);
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
        this.requireWalletReservation(o);
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
        if (actor.role === "merchant_admin")
          this.completePayout(s, o, actor, "admin_attestation");
      } else {
        const o = this.order(s, a.orderId);
        o.payoutStatus = "failed";
        if (o.conversionStatus === "pending")
          this.releaseWallet(s, actor, o, v.evidence);
        else if (o.fundingSource === "wallet")
          this.audit(s, actor, "wallet.retained_after_failed_payout", o.id, {
            reason:
              "External conversion already recorded; no stablecoin return verified",
          });
      }
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
  /** Upgrade a historical administrator confirmation; never execute or record a second payout. */
  async completeRecordedPayment(actor: Actor, orderId: string) {
    authorize(actor, "payout.record");
    demand(
      actor.role === "merchant_admin",
      "FORBIDDEN",
      "Merchant administrator required",
    );
    return this.store.transaction((s) => {
      const o = this.order(s, orderId);
      const confirmation = o.paymentConfirmation;
      demand(
        o.payoutStatus === "sent" && confirmation,
        "INVALID_STATE",
        "Existing administrator payment confirmation required",
      );
      demand(
        confirmation.confirmedBy &&
          ["admin_attestation", "mock_internal_record"].includes(
            confirmation.verification,
          ) &&
          confirmation.actualAmount === o.quote.payoutAmount &&
          s.attempts.some(
            (a) =>
              a.orderId === o.id &&
              a.state === "sent" &&
              a.providerReference === confirmation.providerReference &&
              (a.referenceKind ?? "external") ===
                (confirmation.referenceKind ?? "external"),
          ),
        "PAYMENT_CONFIRMATION_MISMATCH",
        "Existing confirmation and sent attempt must match the order",
      );
      demand(
        !s.refunds.some((r) => r.orderId === o.id && r.kind === "principal"),
        "REFUND_CONFLICT",
        "Principal refund blocks completion",
      );
      demand(
        !s.discrepancies.some((d) => d.orderId === o.id && d.status === "open"),
        "OPEN_DISCREPANCY",
        "Resolve open discrepancies before completion",
      );
      this.completePayout(s, o, actor, confirmation.verification);
      return this.orderView(o, actor);
    });
  }
  /** Synthetic official-provider bookkeeping only. Never an external payment attestation. */
  async confirmMockPayout(actor: Actor, orderId: string, input: unknown) {
    authorize(actor, "payout.record");
    demand(
      actor.role === "merchant_admin",
      "FORBIDDEN",
      "Merchant administrator required",
    );
    const v = z
      .object({
        idempotencyKey: id,
        expectedAmount: decimalString,
        beneficiaryId: id,
        payoutProviderId: id,
        note: z.string().trim().max(500).optional(),
      })
      .strict()
      .parse(input);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(v))
      .digest("hex");
    return this.store.transaction((s) => {
      const o = this.order(s, orderId);
      const replay = s.audits.find(
        (a) =>
          a.action === "payout.mock_confirmed" &&
          a.data.idempotencyKey === v.idempotencyKey,
      );
      const keyAttempt = s.attempts.find(
        (a) => a.idempotencyKey === v.idempotencyKey,
      );
      if (replay || keyAttempt) {
        demand(
          replay?.targetId === orderId &&
            replay.data.fingerprint === fingerprint,
          "IDEMPOTENCY_CONFLICT",
          "Payment key reused with changed details",
        );
        this.completePayout(s, o, actor, "mock_internal_record");
        return this.orderView(o, actor);
      }
      demand(
        o.payoutProviderSnapshot?.scope === "official" &&
          o.payoutProviderSnapshot.status === "active",
        "MOCK_PROVIDER_REQUIRED",
        "Explicit active official provider snapshot required; use manual review for legacy or third-party orders",
      );
      demand(
        o.payoutProviderSnapshot.id === v.payoutProviderId,
        "PAYOUT_PROVIDER_MISMATCH",
        "Payout executor must match the order snapshot",
      );
      demand(
        o.quote.beneficiaryId === v.beneficiaryId,
        "BENEFICIARY_MISMATCH",
        "Recipient must match the order snapshot",
      );
      demand(
        amount(v.expectedAmount, o.quote.payoutCurrency) ===
          o.quote.payoutAmount,
        "PAYOUT_AMOUNT_MISMATCH",
        "Confirmed amount must exactly match the order",
      );
      this.checkCustomer(s, o.customerId);
      this.checkBeneficiary(s, o.customerId, o.quote.beneficiaryId);
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
      // Another browser may retry with a new key. Register that key, but never pay again.
      if (
        o.payoutStatus === "sent" &&
        o.paymentConfirmation?.referenceKind === "mock_internal"
      ) {
        this.audit(s, actor, "payout.mock_confirmed", o.id, {
          idempotencyKey: v.idempotencyKey,
          fingerprint,
          replay: true,
          internalRecordId: o.paymentConfirmation.internalRecordId,
          referenceKind: "mock_internal",
        });
        this.completePayout(s, o, actor, "mock_internal_record");
        return this.orderView(o, actor);
      }
      this.requireWalletReservation(o);
      demand(
        o.depositStatus === "confirmed",
        "FUNDS_NOT_READY",
        "Confirmed stablecoin deposit required",
      );
      const priorAttempts = s.attempts.filter((a) => a.orderId === o.id);
      const previous = priorAttempts.at(-1);
      const reusable =
        priorAttempts.length === 1 &&
        previous &&
        ["approved", "awaiting_approval"].includes(previous.state) &&
        previous.state === o.payoutStatus &&
        !previous.providerReference &&
        !previous.evidence;
      demand(
        (o.payoutStatus === "draft" && priorAttempts.length === 0) || reusable,
        "PAYOUT_LOCKED",
        "Only draft or untouched approved payouts allow simplified confirmation; failed or unknown payouts require manual review",
      );
      const confirmedAt = this.clock().toISOString();
      const internalRecordId = "MOCK-INTERNAL-" + randomUUID();
      const statement =
        "Synthetic MOCK internal record only; no external payment was executed or verified and receipt by the beneficiary is not confirmed.";
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
          providerReference: "MOCK-ALLOCATION-" + o.id,
          actualRate: o.quote.customerRate,
          evidence: statement,
          recordedBy: actor.id,
        };
      }
      const attempt = reusable
        ? previous
        : {
            id: randomUUID(),
            orderId,
            idempotencyKey: v.idempotencyKey,
            makerId: actor.id,
            state: "sent" as const,
            createdAt: confirmedAt,
          };
      if (!reusable) s.attempts.push(attempt);
      Object.assign(attempt, {
        state: "sent",
        idempotencyKey: v.idempotencyKey,
        providerReference: internalRecordId,
        referenceKind: "mock_internal",
        internalRecordId,
        evidence: statement,
      });
      this.recordSent(s, o);
      o.paymentConfirmation = {
        actualAmount: o.quote.payoutAmount,
        // Legacy field aliases are explicitly classified as internal, never bank identifiers/times.
        paidAt: confirmedAt,
        providerReference: internalRecordId,
        confirmedAt,
        confirmedBy: actor.id,
        verification: "mock_internal_record",
        referenceKind: "mock_internal",
        internalRecordId,
        statement,
        ...(v.note ? { note: v.note } : {}),
      };
      this.completePayout(s, o, actor, "mock_internal_record");
      this.audit(s, actor, "payout.mock_confirmed", o.id, {
        idempotencyKey: v.idempotencyKey,
        fingerprint,
        internalRecordId,
        referenceKind: "mock_internal",
        verification: "mock_internal_record",
        confirmedAt,
        statement,
        note: v.note,
      });
      this.emit(s, "payout.sent", o.id, {
        verification: "mock_internal_record",
        referenceKind: "mock_internal",
        internalRecordId,
      });
      return this.orderView(o, actor);
    });
  }
  private requireProviderScope(s: State, actor: Actor, o: Order) {
    if (actor.role !== "payout_provider") return;
    demand(
      !!actor.payoutProviderId &&
        o.payoutProviderSnapshot?.id === actor.payoutProviderId &&
        o.payoutProviderSnapshot.status === "active" &&
        s.payoutProviders?.some(
          (p) => p.id === actor.payoutProviderId && p.status === "active",
        ),
      "FORBIDDEN",
      "Assigned active payout provider required",
    );
  }
  /** Mock bookkeeping only: the administrator attests a payment made outside this application. */
  async confirmManualPayout(actor: Actor, orderId: string, input: unknown) {
    if (actor.role !== "payout_provider") authorize(actor, "payout.record");
    demand(
      actor.role === "merchant_admin" || actor.role === "payout_provider",
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
        evidence: (actor.role === "payout_provider"
          ? z.string().trim().max(1000)
          : text
        ).optional(),
      })
      .strict()
      .parse(input);
    demand(
      actor.role === "payout_provider" || v.evidence,
      "PAYMENT_DETAILS_REQUIRED",
      "Administrator evidence is required",
    );
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(v))
      .digest("hex");
    return this.store.transaction((s) => {
      const o = this.order(s, orderId);
      this.requireProviderScope(s, actor, o);
      demand(
        !s.audits.some(
          (a) =>
            a.action === "payout.mock_confirmed" &&
            a.data.idempotencyKey === v.idempotencyKey,
        ),
        "IDEMPOTENCY_CONFLICT",
        "Payment key already belongs to a synthetic confirmation",
      );
      const existing = s.attempts.find(
        (a) => a.idempotencyKey === v.idempotencyKey,
      );
      if (existing) {
        const audit = s.audits.find(
          (a) =>
            a.action ===
              (actor.role === "payout_provider"
                ? "payout.provider_attested"
                : "payout.admin_attested") && a.data.attemptId === existing.id,
        );
        demand(
          existing.orderId === orderId &&
            audit?.data.fingerprint === fingerprint,
          "IDEMPOTENCY_CONFLICT",
          "Payment key reused with changed details",
        );
        if (o.payoutStatus === "sent")
          this.completePayout(
            s,
            o,
            actor,
            actor.role === "payout_provider"
              ? "provider_attestation"
              : "admin_attestation",
          );
        return this.orderView(o, actor);
      }
      this.requireWalletReservation(o);
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
          v.actualAmount &&
            v.paidAt &&
            (actor.role === "payout_provider" || v.providerReference),
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
          this.fundsMode === "live"
            ? "liability:provider-settlement:" +
                (o.payoutProviderSnapshot?.id ?? "unassigned")
            : "asset:custody:mock",
          this.clock(),
        );
        transfer(
          s,
          "conversion-target:" + o.id,
          o.quote.payoutCurrency,
          o.quote.payoutAmount,
          this.fundsMode === "live"
            ? "asset:provider:attested:" +
                (o.payoutProviderSnapshot?.id ?? "unassigned")
            : "asset:provider:mock",
          "liability:payout:" + o.id,
          this.clock(),
        );
        o.conversionStatus = "recorded";
        o.conversion = {
          providerReference:
            (this.fundsMode === "live" ? "ALLOCATION-" : "MOCK-ALLOCATION-") +
            o.id,
          actualRate: o.quote.customerRate,
          evidence:
            "Operator recorded manual external allocation; not bank verified",
          recordedBy: actor.id,
        };
        this.audit(
          s,
          actor,
          actor.role === "payout_provider"
            ? "allocation.provider_attested"
            : "allocation.admin_attested",
          o.id,
        );
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
      const internalRecordId =
        actor.role === "payout_provider" ? "PAY-" + randomUUID() : undefined;
      const recordedReference = v.providerReference ?? internalRecordId;
      if (internalRecordId) {
        attempt.internalRecordId = internalRecordId;
        attempt.referenceKind = v.providerReference
          ? "external"
          : "system_internal";
      }
      attempt.idempotencyKey = v.idempotencyKey;
      attempt.state = v.outcome;
      attempt.providerReference = recordedReference;
      attempt.evidence = v.evidence;
      if (v.outcome === "sent") {
        this.recordSent(s, o);
        o.paymentConfirmation = {
          actualAmount: amount(v.actualAmount!, o.quote.payoutCurrency),
          paidAt: v.paidAt!,
          providerReference: recordedReference!,
          ...(internalRecordId
            ? {
                internalRecordId,
                referenceKind: v.providerReference
                  ? ("external" as const)
                  : ("system_internal" as const),
              }
            : {}),
          confirmedBy: actor.id,
          verification:
            actor.role === "payout_provider"
              ? "provider_attestation"
              : "admin_attestation",
        };
        this.completePayout(
          s,
          o,
          actor,
          actor.role === "payout_provider"
            ? "provider_attestation"
            : "admin_attestation",
        );
      } else o.payoutStatus = "unknown";
      this.audit(
        s,
        actor,
        actor.role === "payout_provider"
          ? "payout.provider_attested"
          : "payout.admin_attested",
        o.id,
        {
          attemptId: attempt.id,
          fingerprint,
          outcome: v.outcome,
          actualAmount: v.actualAmount,
          paidAt: v.paidAt,
          providerReference: v.providerReference,
          ...(internalRecordId
            ? {
                internalRecordId,
                referenceKind: v.providerReference
                  ? "external"
                  : "system_internal",
              }
            : {}),
        },
      );
      this.emit(s, "payout." + v.outcome, o.id, {
        verification:
          actor.role === "payout_provider"
            ? "provider_attestation"
            : "admin_attestation",
      });
      return this.orderView(o, actor);
    });
  }
  /** Small, unscanned DEMO attachment stored in the existing mock state, never public object storage. */
  get receipts() {
    return new ReceiptService(this.store, this.clock);
  }
  async uploadReceiptFile(actor: Actor, orderId: string, input: unknown) {
    if (actor.role !== "payout_provider") authorize(actor, "receipt.upload");
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
    const encoded = await encodeReceipt(new Uint8Array(bytes));
    return this.store.transaction((s) => {
      const o = this.order(s, orderId);
      this.requireProviderScope(s, actor, o);
      demand(
        o.payoutStatus === "sent",
        "INVALID_STATE",
        "Confirm payment before attaching receipt",
      );
      o.receiptFile = {
        privateOriginal: true,
        ...v,
        dataBase64: Buffer.from(encoded.data).toString("base64"),
        ...(encoded.storageEncoding
          ? { storageEncoding: encoded.storageEncoding }
          : {}),
        storedSize: encoded.data.length,
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
    if (actor.role === "payout_provider")
      this.requireProviderScope(s, actor, o);
    else authorize(actor, "order.read", o.customerId);
    demand(
      o.receiptFile,
      "NOT_FOUND",
      "No demo file attached; metadata alone is not a file",
    );
    demand(
      !o.receiptFile.privateOriginal ||
        actor.role === "merchant_admin" ||
        actor.role === "payout_provider",
      "FORBIDDEN",
      "New receipt originals are administrator private; publish a redacted single-customer copy instead",
    );
    const file = structuredClone(o.receiptFile);
    const bytes = await decodeReceipt(
      new Uint8Array(Buffer.from(file.dataBase64, "base64")),
      file.storageEncoding,
      file.size,
    );
    return {
      ...file,
      dataBase64: Buffer.from(bytes).toString("base64"),
      storageEncoding: undefined,
    };
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
        referenceKind: z
          .enum(["mock_internal", "system_internal", "external"])
          .optional(),
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
      demand(
        (v.referenceKind ?? "external") ===
          (attempt.referenceKind ?? "external"),
        "REFERENCE_KIND_MISMATCH",
        "Explicit mock_internal reference kind required for synthetic records; external references are not interchangeable",
      );
      if (
        v.providerReference !== attempt.providerReference ||
        amount(v.actualAmount, o.quote.payoutCurrency) !== o.quote.payoutAmount
      ) {
        const d = {
          id: randomUUID(),
          orderId,
          kind: "payout_mismatch",
          detail: "Recorded amount or reference differs from order.",
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
        referenceKind: attempt.referenceKind ?? "external",
        reference: v.providerReference,
      });
      this.completePayout(s, o, actor, "financial_review");
      return { matched: true, orderId };
    });
  }
  /** A bank API/receipt is not used to establish this administrative completion. */
  private isCompleted(o: Order): boolean {
    return o.payoutStatus === "sent" && (!!o.completion || o.reconciled);
  }
  private completePayout(
    s: State,
    o: Order,
    actor: Actor,
    basis: NonNullable<Order["completion"]>["basis"],
  ) {
    demand(
      o.payoutStatus === "sent",
      "INVALID_STATE",
      "Sent payout required for completion",
    );
    if (!o.completion) {
      demand(
        !s.discrepancies.some((d) => d.orderId === o.id && d.status === "open"),
        "OPEN_DISCREPANCY",
        "Resolve open discrepancies before completing payment",
      );
      o.completion = {
        basis,
        completedAt: this.clock().toISOString(),
        completedBy: actor.id,
      };
      this.audit(s, actor, "order.completed", o.id, {
        ...o.completion,
        bankVerified: false,
      });
    }
    this.accrueCommission(s, o);
  }
  private accrueCommission(s: State, o: Order) {
    if (
      !this.isCompleted(o) ||
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
      demand(
        o.fundingSource !== "wallet",
        "WALLET_REFUND_UNSUPPORTED",
        "Wallet orders use cancellation or verified-failure release; external refunds are disabled to prevent duplicate credits",
      );
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
          this.isCompleted(this.order(s, c.orderId)) &&
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
          this.isCompleted(this.order(s, c.orderId)) &&
            !s.discrepancies.some(
              (d) => d.orderId === c.orderId && d.status === "open",
            ),
          "SETTLEMENT_BLOCKED",
          "Commission order is not completed or has an open discrepancy",
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
  /** Merchant-provided target-payout rows. Raw account data is never persisted. */
  async importMerchantBatch(actor: Actor, input: unknown) {
    const v = z
      .object({
        customerId: id,
        clientBatchId: id,
        rows: z.array(z.unknown()).min(1).max(100),
      })
      .strict()
      .parse(input);
    authorize(actor, "batch.create", v.customerId);
    authorize(actor, "beneficiary.create", v.customerId);
    return this.store.transaction((s) => {
      demand(
        this.checkCustomer(s, v.customerId).kind === "company",
        "MERCHANT_REQUIRED",
        "商户模板仅适用于企业商户，请先选择商户",
      );
      const digest = createHash("sha256")
        .update(
          JSON.stringify(
            v.rows.map((raw) =>
              raw && typeof raw === "object" && !Array.isArray(raw)
                ? Object.fromEntries(
                    Object.entries(raw).sort(([a], [b]) => a.localeCompare(b)),
                  )
                : raw,
            ),
          ),
        )
        .digest("hex");
      const existing = s.batches.find(
        (b) =>
          b.customerId === v.customerId && b.clientBatchId === v.clientBatchId,
      );
      if (existing) {
        demand(
          s.merchantImportDigests?.[existing.id] === digest,
          "IDEMPOTENCY_CONFLICT",
          "批次编号已用于不同内容，请重新选择文件",
        );
        return {
          batch: existing,
          items: s.batchItems.filter((i) => i.batchId === existing.id),
        };
      }
      const batch = {
        id: randomUUID(),
        customerId: v.customerId,
        clientBatchId: v.clientBatchId,
        itemIds: [] as string[],
        createdAt: this.clock().toISOString(),
      };
      const seen = new Set<string>();
      v.rows.forEach((raw, index) => {
        const validated = validateMerchantRow(raw, index + 2);
        const { row, errors } = validated;
        if (
          raw &&
          typeof raw === "object" &&
          (typeof (raw as Record<string, unknown>).clientItemId !== "string" ||
            !((raw as Record<string, unknown>).clientItemId as string).trim())
        )
          row.clientItemId = `row_${index + 2}_${randomUUID()}`;
        if (seen.has(row.clientItemId)) errors.push("商户行号重复");
        seen.add(row.clientItemId);
        if (
          s.batchItems.some(
            (i) =>
              i.clientItemId === row.clientItemId &&
              i.status !== "error" &&
              s.batches.some(
                (b) => b.id === i.batchId && b.customerId === v.customerId,
              ),
          )
        )
          errors.push("该商户行号已导入，请勿重复提交");
        let beneficiaryId = "";
        if (!errors.length) {
          const beneficiary: Beneficiary = {
            id: randomUUID(),
            customerId: v.customerId,
            name: row.name,
            bankName: row.bankName,
            country: defaultPayoutCountry(row.targetCurrency),
            currency: row.targetCurrency,
            accountMasked: "**** " + row.accountNumber.slice(-4),
            accountToken: "demo_" + randomUUID(),
            status: "saved",
            createdBy: actor.id,
          };
          s.beneficiaries.push(beneficiary);
          beneficiaryId = beneficiary.id;
        }
        const item: import("./types").BatchItem = {
          id: randomUUID(),
          batchId: batch.id,
          clientItemId: row.clientItemId,
          beneficiaryId,
          sourceCurrency: row.sourceCurrency,
          sourceAmount: "0.000000",
          amountMode: "target_payout",
          targetAmount: row.targetAmount,
          targetCurrency: row.targetCurrency,
          recipientName: row.name,
          bankName: row.bankName,
          accountMasked: /^\d{8,34}$/.test(row.accountNumber)
            ? "**** " + row.accountNumber.slice(-4)
            : undefined,
          rowNumber: row.sourceRowNumber,
          status: errors.length ? "error" : "valid",
          errors,
        };
        s.batchItems.push(item);
        batch.itemIds.push(item.id);
      });
      s.batches.push(batch);
      (s.merchantImportDigests ??= {})[batch.id] = digest;
      this.audit(s, actor, "batch.imported", batch.id, {
        rowCount: v.rows.length,
        format: "merchant_target_v1",
      });
      return {
        batch,
        items: s.batchItems.filter((i) => i.batchId === batch.id),
      };
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
              usableBeneficiary(b),
          )
        )
          errors.push("Recipient unavailable or belongs to another customer");
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
  async quoteBatch(actor: Actor, batchId: string) {
    return this.store.transaction((s) => {
      const batch = s.batches.find((b) => b.id === batchId);
      demand(batch, "NOT_FOUND", "Batch missing");
      authorize(actor, "batch.create", batch.customerId);
      demand(
        !s.batchItems.some(
          (i) => i.batchId === batchId && i.status === "created",
        ),
        "BATCH_SUBMITTED",
        "Submitted batches cannot be repriced",
      );
      const items = s.batchItems.filter(
        (i) => i.batchId === batchId && i.status === "valid",
      );
      demand(items.length > 0, "EMPTY_BATCH", "No valid batch rows");
      const quotes = items.map((item) => {
        const q = this.quote(s, {
          customerId: batch.customerId,
          beneficiaryId: item.beneficiaryId,
          sourceCurrency: item.sourceCurrency,
          ...(item.amountMode === "target_payout"
            ? {
                amountMode: "target_payout" as const,
                targetAmount: item.targetAmount,
                payoutCurrency: item.targetCurrency,
              }
            : { sourceAmount: item.sourceAmount }),
        });
        item.quoteId = q.id;
        item.sourceAmount = q.sourceAmount;
        return {
          itemId: item.id,
          clientItemId: item.clientItemId,
          ...this.quoteView(q, actor),
        };
      });
      const totals = (["USDT", "USDC"] as const).map((currency) => {
        const selected = quotes.filter((q) => q.sourceCurrency === currency);
        const sum = (
          field: "sourceAmount" | "serviceFee" | "channelFee" | "totalDeposit",
        ) =>
          decimal(
            selected.reduce((n, q) => n + units(q[field]!, 6), 0n),
            6,
          );
        return {
          currency,
          sourceAmount: sum("sourceAmount"),
          serviceFee: sum("serviceFee"),
          channelFee: sum("channelFee"),
          totalDeposit: sum("totalDeposit"),
          available: decimal(
            this.walletAvailable(s, batch.customerId, currency),
            6,
          ),
        };
      });
      this.audit(s, actor, "batch.quoted", batch.id, {
        quoteIds: quotes.map((q) => q.id),
      });
      return {
        batch,
        quotes,
        totals,
        createdAt: quotes[0].createdAt,
        expiresAt: quotes.map((q) => q.expiresAt!).sort()[0],
      };
    });
  }
  async submitBatch(actor: Actor, batchId: string, input: unknown = {}) {
    const { fundingSource = "deposit", quoteIds } = z
      .object({
        fundingSource: z.enum(["deposit", "wallet"]).optional(),
        quoteIds: z.array(id).max(100).optional(),
      })
      .strict()
      .parse(input);
    return this.store.transaction((s) => {
      const batch = s.batches.find((b) => b.id === batchId);
      demand(batch, "NOT_FOUND", "Batch missing");
      authorize(actor, "batch.create", batch.customerId);
      if (fundingSource === "wallet") {
        const items = s.batchItems.filter(
          (i) => i.batchId === batchId && i.status !== "error",
        );
        demand(
          items.length && quoteIds?.length && items.every((i) => i.quoteId),
          "BATCH_QUOTE_REQUIRED",
          "Preview batch quotes and submit their IDs",
        );
        demand(
          JSON.stringify(quoteIds) ===
            JSON.stringify(items.map((i) => i.quoteId)),
          "BATCH_QUOTE_CHANGED",
          "Batch preview changed; review the new quotes before submitting",
        );
      }
      demand(
        !s.orders.some(
          (o) =>
            o.batchId === batchId &&
            (o.fundingSource ?? "deposit") !== fundingSource,
        ),
        "IDEMPOTENCY_CONFLICT",
        "Batch funding source cannot change",
      );
      for (const item of s.batchItems.filter(
        (i) => i.batchId === batchId && i.status === "valid",
      )) {
        const q =
          fundingSource === "wallet"
            ? s.quotes.find((q) => q.id === item.quoteId)
            : this.quote(s, {
                customerId: batch.customerId,
                beneficiaryId: item.beneficiaryId,
                sourceCurrency: item.sourceCurrency,
                ...(item.amountMode === "target_payout"
                  ? {
                      amountMode: "target_payout" as const,
                      targetAmount: item.targetAmount,
                      payoutCurrency: item.targetCurrency,
                    }
                  : { sourceAmount: item.sourceAmount }),
              });
        demand(
          q,
          "BATCH_QUOTE_REQUIRED",
          "Preview batch quotes and totals before submitting wallet orders",
        );
        const o = this.makeOrder(
          s,
          actor,
          q.id,
          `batch_${batchId}_${item.clientItemId}`,
          batchId,
          fundingSource,
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
      delete result.pricingSnapshot;
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
      completionStatus: this.isCompleted(o)
        ? "completed"
        : o.payoutStatus === "sent"
          ? "pending_review"
          : "in_progress",
      completionBasis:
        o.completion?.basis ??
        (o.reconciled && o.payoutStatus === "sent" ? "financial_review" : null),
    } as Record<string, unknown>;
    view.receiptFileAvailable =
      !!o.receiptFile &&
      (!o.receiptFile.privateOriginal || actor.role === "merchant_admin");
    delete view.receiptFile;
    if (actor.role !== "merchant_admin") delete view.receiptAttachmentIds;
    if (actor.role === "customer") {
      delete view.conversion;
      if (o.receipt) view.receipt = { available: true };
    }
    return view;
  }
  async dashboard(actor: Actor) {
    let s = await this.store.read();
    const eligibility = (
      c: Commission,
    ): "hold" | "available" | "allocated" | "frozen" => {
      if (c.settlementId) return "allocated";
      if (
        !this.isCompleted(this.order(s, c.orderId)) ||
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
    if (!s.pricingHistory?.length)
      s = await this.store.transaction((state) => {
        this.ensurePricing(state);
        return state;
      });
    const customer = actor.role === "customer";
    return {
      mode: "MOCK",
      actor,
      walletRates: this.currentPricing(s)
        .rates.filter(
          (r) => this.currentPricing(s).routes[r.payoutCurrency]?.enabled,
        )
        .map((r) => ({
          sourceCurrency: r.sourceCurrency,
          payoutCurrency: r.payoutCurrency,
          customerRate: r.customerRate,
          configVersion: this.currentPricing(s).version,
          baselineAsOf: this.currentPricing(s).baseline.asOf,
          baselineExpiresAt: this.currentPricing(s).baseline.expiresAt,
          baselineSource: "MOCK",
          stale:
            Date.parse(this.currentPricing(s).baseline.expiresAt) <=
            this.clock().getTime(),
        })),
      walletBalances: s.customers
        .filter((c) => !customer || c.id === actor.customerId)
        .flatMap((c) =>
          (["USDT", "USDC"] as const).map((currency) => ({
            customerId: c.id,
            currency,
            available: decimal(this.walletAvailable(s, c.id, currency), 6),
            frozen: decimal(
              s.orders
                .filter(
                  (o) =>
                    o.customerId === c.id &&
                    o.quote.sourceCurrency === currency &&
                    o.fundingSource === "wallet" &&
                    o.walletFundingStatus === "reserved",
                )
                .reduce((n, o) => n + units(o.quote.totalDeposit, 6), 0n),
              6,
            ),
          })),
        ),
      walletDeposits: s.audits
        .filter(
          (a) =>
            a.action === "wallet.deposited" &&
            (!customer || a.data.customerId === actor.customerId),
        )
        .map((a) => ({ id: a.targetId, at: a.at, ...a.data })),
      pricingFixture: customer ? undefined : this.config,
      pricingCurrent: customer ? undefined : this.currentPricing(s),
      pricingHistory: customer ? undefined : (s.pricingHistory ?? []),
      payoutProviders: customer
        ? undefined
        : (s.payoutProviders ?? initialProviders()),
      storageMode: "ephemeral_mock",
      pricingBaselineExpired:
        Date.parse(this.currentPricing(s).baseline.expiresAt) <=
        this.clock().getTime(),
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
        .map(({ accountToken, recipientAccount, ...b }) => ({
          ...b,
          ...(recipientAccount
            ? {
                recipientMethod: recipientAccount.method,
                detailsComplete: true,
              }
            : {}),
        })),
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
