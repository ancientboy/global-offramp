import { Currency } from "./money";
export type Role =
  "customer" | "operations" | "finance" | "auditor" | "partner";
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
  country: "CN" | "US";
  currency: "CNY" | "USD";
  accountMasked: string;
  accountToken: string;
  status: "pending" | "approved" | "suspended";
  createdBy: string;
  approvedBy?: string;
}
export interface Quote {
  id: string;
  customerId: string;
  beneficiaryId: string;
  sourceCurrency: "USDT" | "USDC";
  payoutCurrency: "CNY" | "USD";
  sourceAmount: string;
  amountMode: "principal" | "total_deposit";
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
  id: string;
  customerId: string;
  quote: Quote;
  clientOrderId: string;
  depositStatus: "awaiting" | "confirmed" | "exception";
  conversionStatus: "pending" | "recorded";
  payoutStatus: PayoutStatus;
  receiptStatus: "none" | "uploaded" | "verified";
  reconciled: boolean;
  createdAt: string;
  depositEventId?: string;
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
