import { Currency } from "./money";
export type Role =
  | "merchant_admin"
  | "customer"
  | "operations"
  | "finance"
  | "auditor"
  | "partner";
export interface Actor {
  id: string;
  role: Role;
  customerId?: string;
  partnerId?: string;
}
export interface Customer {
  id: string;
  kind: "personal" | "company";
  name: string;
  status: "pending" | "approved" | "suspended";
  serviceFeeOverride?: string;
  partnerId?: string;
  attributionVersion?: string;
}
export interface Beneficiary {
  id: string;
  customerId: string;
  name: string;
  country: string;
  currency: "CNY" | "USD" | "EUR" | "MXN" | "BRL" | "GBP";
  bankName?: string;
  accountMasked: string;
  accountToken: string;
  status: "saved" | "pending" | "approved" | "suspended";
  createdBy: string;
  approvedBy?: string;
}
export interface PricingBaseline {
  USDT_USD: string;
  USDC_USD: string;
  USD_CNY: string;
  USD_EUR?: string;
  USD_GBP?: string;
  USD_MXN?: string;
  USD_BRL?: string;
  asOf: string;
  expiresAt: string;
}
export interface PricingRoute {
  enabled: boolean;
  adjustmentMode: "fixed" | "percentage";
  adjustmentDirection: "add" | "subtract";
  adjustment: string;
}
export interface PricingVersion {
  marketReference?: {
    batchId: string;
    fetchedAt: string;
    fxDate: string;
    fxSource: "ECB";
    stablecoinSource: "Kraken";
    usdRates: Record<"USD" | "CNY" | "EUR" | "GBP" | "MXN" | "BRL", string>;
    stablecoinUsd: Record<"USDT" | "USDC", string>;
    rates: {
      sourceCurrency: "USDT" | "USDC";
      payoutCurrency: "USD" | "CNY" | "EUR" | "GBP" | "MXN" | "BRL";
      referenceRate: string;
    }[];
  };
  mode: "MOCK";
  version: string;
  baseline: PricingBaseline;
  routes: Record<"CNY" | "USD", PricingRoute> &
    Partial<Record<"EUR" | "MXN" | "BRL" | "GBP", PricingRoute>>;
  rates: {
    sourceCurrency: "USDT" | "USDC";
    payoutCurrency: "CNY" | "USD" | "EUR" | "MXN" | "BRL" | "GBP";
    referenceRate: string;
    customerRate: string;
  }[];
  serviceFee: string;
  channelFee: string;
  publishedAt?: string;
  publishedBy?: string;
}
export interface PayoutProvider {
  id: string;
  name: string;
  status: "active" | "disabled";
  scope: "official" | "third_party";
  routes: ("CNY" | "USD" | "EUR" | "MXN" | "BRL" | "GBP")[];
  isDefault: boolean;
  updatedAt: string;
}
export interface Quote {
  pricingSnapshot?: PricingVersion;
  id: string;
  customerId: string;
  beneficiaryId: string;
  sourceCurrency: "USDT" | "USDC";
  payoutCurrency: "CNY" | "USD" | "EUR" | "MXN" | "BRL" | "GBP";
  sourceAmount: string;
  amountMode: "principal" | "total_deposit" | "target_payout";
  inputCurrency?: Currency;
  requestedPayoutAmount?: string;
  inputAmount: string;
  payoutAmount: string;
  serviceFee: string;
  channelFee: string;
  totalDeposit: string;
  costRate: string;
  referenceRate: string;
  customerRate: string;
  configVersion: string;
  feeRuleVersion: string;
  partnerId?: string;
  attributionVersion?: string;
  commissionRate: string;
  commissionRuleVersion: string;
  createdAt: string;
  expiresAt: string;
}
export type PayoutStatus =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "sent"
  | "unknown"
  | "failed"
  | "cancelled";
export interface Order {
  receiptAttachmentIds?: string[];
  orderNumber?: string;
  payoutProviderSnapshot?: PayoutProvider;
  fundingSource?: "deposit" | "wallet";
  walletFundingStatus?: "reserved" | "consumed" | "released";
  id: string;
  customerId: string;
  quote: Quote;
  clientOrderId: string;
  depositStatus: "awaiting" | "confirmed" | "exception";
  conversionStatus: "pending" | "recorded";
  payoutStatus: PayoutStatus;
  receiptStatus: "none" | "uploaded" | "verified";
  reconciled: boolean;
  /** Business completion is separate from optional financial reconciliation. */
  completion?: {
    basis: "admin_attestation" | "mock_internal_record" | "financial_review";
    completedAt: string;
    completedBy: string;
  };
  createdAt: string;
  depositEventId?: string;
  fundingExpiresAt?: string;
  fundingInstruction?: {
    mode: "mock";
    payable: false;
    status: "mock_nonpayable";
    reference: string;
    network: "MOCK";
    address: null;
    currency: "USDT" | "USDC";
    amount: string;
    expiresAt: string;
  };
  paymentConfirmation?: {
    actualAmount: string;
    paidAt: string;
    providerReference: string;
    confirmedBy: string;
    verification: "admin_attestation" | "mock_internal_record";
    referenceKind?: "mock_internal" | "external";
    internalRecordId?: string;
    confirmedAt?: string;
    statement?: string;
    note?: string;
  };
  receiptFile?: {
    privateOriginal?: boolean;
    fileName: string;
    contentType: string;
    dataBase64: string;
    size: number;
    sha256: string;
    mode: "mock";
    scanStatus: "not_scanned";
  };
  conversion?: {
    providerReference: string;
    actualRate: string;
    evidence: string;
    recordedBy: string;
  };
  receipt?: { objectKey: string; uploadedBy: string };
  batchId?: string;
}
export interface PayoutAttempt {
  id: string;
  orderId: string;
  idempotencyKey: string;
  makerId: string;
  checkerId?: string;
  state: PayoutStatus;
  createdAt: string;
  providerReference?: string;
  evidence?: string;
  referenceKind?: "mock_internal" | "external";
  internalRecordId?: string;
  verifiedBy?: string;
}
export interface Journal {
  id: string;
  businessKey: string;
  createdAt: string;
  reversalOf?: string;
  lines: {
    account: string;
    currency: Currency;
    debit: string;
    credit: string;
  }[];
}
export interface Audit {
  id: string;
  actorId: string;
  action: string;
  targetId: string;
  data: Record<string, unknown>;
  at: string;
}
export interface Outbox {
  id: string;
  topic: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  deliveredAt?: string;
}
export interface Refund {
  id: string;
  orderId: string;
  idempotencyKey: string;
  kind: "principal" | "service_fee";
  amount: string;
  currency: Currency;
  status: "requested" | "approved" | "recorded";
  makerId: string;
  checkerId?: string;
  providerReference?: string;
  evidence?: string;
}
export interface Commission {
  id: string;
  orderId: string;
  partnerId: string;
  currency: Currency;
  base: string;
  rate: string;
  value: string;
  ruleVersion: string;
  attributionVersion: string;
  eligibleAt: string;
  state: "available" | "settled" | "adjustment";
  originalCommissionId?: string;
  refundId?: string;
  settlementId?: string;
}
export interface Settlement {
  id: string;
  partnerId: string;
  month: string;
  currency: Currency;
  commissionIds: string[];
  amount: string;
  status: "draft" | "approved" | "cancelled";
  makerId: string;
  checkerId?: string;
}
export interface Discrepancy {
  id: string;
  orderId?: string;
  kind: string;
  detail: string;
  status: "open" | "resolved";
  evidence?: string;
  resolvedBy?: string;
}
export interface Batch {
  id: string;
  customerId: string;
  clientBatchId: string;
  itemIds: string[];
  createdAt: string;
}
export interface BatchItem {
  amountMode?: "principal" | "target_payout";
  targetAmount?: string;
  targetCurrency?: "CNY" | "USD" | "EUR" | "MXN" | "BRL" | "GBP";
  recipientName?: string;
  bankName?: string;
  accountMasked?: string;
  rowNumber?: number;
  quoteId?: string;
  id: string;
  batchId: string;
  clientItemId: string;
  beneficiaryId: string;
  sourceAmount: string;
  sourceCurrency: "USDT" | "USDC";
  status: "valid" | "error" | "created";
  errors: string[];
  orderId?: string;
}
export interface State {
  merchantImportDigests?: Record<string, string>;
  privateReceipts?: import("./receipts").PrivateReceipt[];
  pricingHistory?: PricingVersion[];
  payoutProviders?: PayoutProvider[];
  customers: Customer[];
  beneficiaries: Beneficiary[];
  quotes: Quote[];
  orders: Order[];
  attempts: PayoutAttempt[];
  journals: Journal[];
  audits: Audit[];
  outbox: Outbox[];
  webhookEvents: { id: string; transactionId: string; hash: string }[];
  refunds: Refund[];
  commissions: Commission[];
  settlements: Settlement[];
  discrepancies: Discrepancy[];
  batches: Batch[];
  batchItems: BatchItem[];
}
export interface Store {
  transaction<T>(work: (state: State) => T | Promise<T>): Promise<T>;
  read(): Promise<State>;
  health(): Promise<boolean>;
}
