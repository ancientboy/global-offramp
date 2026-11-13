/** Read models returned by the MOCK API. All monetary values remain decimal strings. */
export type ActorKey =
  | "admin-demo"
  | "customer-demo"
  | "company-demo"
  | "maker-demo"
  | "checker-demo"
  | "checker-two-demo"
  | "auditor-demo"
  | "partner-demo";
export type ViewRole = "customer" | "admin" | "partner";
export interface Quote {
  amountMode?: "total_deposit" | "principal" | "target_payout";
  inputAmount?: string;
  inputCurrency?: string;
  requestedPayoutAmount?: string;
  id: string;
  customerId: string;
  beneficiaryId: string;
  sourceCurrency: "USDT" | "USDC";
  payoutCurrency: "CNY" | "USD" | "EUR" | "MXN" | "BRL" | "GBP";
  sourceAmount: string;
  payoutAmount: string;
  serviceFee: string;
  channelFee: string;
  totalDeposit: string;
  customerRate: string;
  configVersion: string;
  feeRuleVersion: string;
  createdAt: string;
  expiresAt: string;
  costRate?: string;
  referenceRate?: string;
}
export interface Order {
  id: string;
  orderNumber?: string;
  payoutProviderSnapshot?: {
    id: string;
    name: string;
    scope: "official" | "third_party";
    routes: string[];
    status?: string;
  };
  paymentConfirmation?: {
    paidAt: string;
    actualAmount: string;
    providerReference: string;
    verification: string;
    referenceKind?: string;
    internalRecordId?: string;
    confirmedAt?: string;
    confirmedBy?: string;
    statement?: string;
    note?: string;
  };
  customerId: string;
  clientOrderId: string;
  quote: Quote;
  depositStatus: string;
  conversionStatus: string;
  payoutStatus: string;
  receiptStatus: string;
  receiptFileAvailable?: boolean;
  reconciled: boolean;
  completionStatus?: "completed" | "pending_review" | "in_progress";
  completionBasis?:
    | "admin_attestation"
    | "provider_attestation"
    | "mock_internal_record"
    | "financial_review"
    | null;
  completion?: {
    basis:
      | "admin_attestation"
      | "provider_attestation"
      | "mock_internal_record"
      | "financial_review";
    completedAt: string;
    completedBy: string;
  };
  createdAt: string;
  batchId?: string;
  fundingSource?: "wallet" | "deposit";
  walletFundingStatus?: "reserved" | "consumed" | "released";
  fundingExpiresAt?: string;
  fundingInstruction?: {
    mode: "mock";
    payable: false;
    status: string;
    reference: string;
    network: string;
    address: null;
    currency: string;
    amount: string;
    expiresAt: string;
  };
}
export interface Customer {
  id: string;
  name: string;
  kind: "personal" | "company";
  status: string;
  serviceFeeOverride?: string;
  partnerId?: string;
}
export interface Beneficiary {
  id: string;
  customerId: string;
  name: string;
  country: string;
  currency: "CNY" | "USD" | "EUR" | "MXN" | "BRL" | "GBP";
  accountMasked: string;
  bankName?: string;
  recipientMethod?: import("../../../packages/core/src/route-catalog").RecipientMethodId;
  detailsComplete?: boolean;
  status: string;
  createdBy: string;
}
export interface Attempt {
  id: string;
  orderId: string;
  state: string;
  makerId: string;
  checkerId?: string;
  providerReference?: string;
  referenceKind?: string;
  internalRecordId?: string;
}
export interface Refund {
  id: string;
  orderId: string;
  kind: "principal" | "service_fee";
  amount: string;
  currency: string;
  status: string;
  makerId?: string;
  checkerId?: string;
  providerReference?: string;
}
export interface Discrepancy {
  id: string;
  orderId?: string;
  kind: string;
  detail: string;
  status: string;
}
export interface Commission {
  id: string;
  partnerId?: string;
  customerAlias?: string;
  currency: string;
  base: string;
  rate: string;
  value: string;
  state: string;
  eligibleAt: string;
  eligibility?: "hold" | "available" | "allocated" | "frozen";
  settlementId?: string;
}
export interface Settlement {
  id: string;
  partnerId?: string;
  month: string;
  currency: string;
  amount: string;
  status: string;
  makerId?: string;
  checkerId?: string;
}
export interface Batch {
  id: string;
  customerId: string;
  clientBatchId: string;
  createdAt: string;
}
export interface BatchItem {
  targetAmount?: string;
  targetCurrency?: string;
  amountMode?: "principal" | "target_payout";
  recipientName?: string;
  bankName?: string;
  accountMasked?: string;
  rowNumber?: number;
  id: string;
  batchId: string;
  clientItemId: string;
  beneficiaryId: string;
  sourceAmount: string;
  sourceCurrency: string;
  status: "valid" | "error" | "created";
  errors: string[];
  orderId?: string;
}
export interface BatchPreview {
  batch: Batch;
  quotes: (Quote & { itemId: string; clientItemId: string })[];
  totals: {
    currency: string;
    sourceAmount: string;
    serviceFee: string;
    channelFee: string;
    totalDeposit: string;
    available: string;
  }[];
  createdAt: string;
  expiresAt: string;
}
export interface BatchResult {
  batch: Batch;
  items: BatchItem[];
}
export interface Audit {
  id: string;
  actorId: string;
  action: string;
  targetId: string;
  at: string;
}
export interface Pricing {
  version: string;
  feeRuleVersion: string;
  serviceFee: string;
  channelFee: string;
  commissionRate: string;
  commissionHoldDays: number;
  routes: Record<
    string,
    {
      enabled: boolean;
      country: string;
      customerRate: string;
      costRate: string;
      referenceRate: string;
    }
  >;
}
export interface WalletBalance {
  customerId: string;
  currency: "USDT" | "USDC";
  available: string;
  frozen: string;
}
export interface WalletDeposit {
  id: string;
  customerId: string;
  currency: "USDT" | "USDC";
  amount: string;
  at: string;
}
export interface Dashboard {
  partners?: { id: string; name: string; status: string }[];
  walletRates?: {
    sourceCurrency?: string;
    payoutCurrency: string;
    customerRate: string;
    configVersion: string;
    baselineAsOf?: string;
    baselineExpiresAt?: string;
    baselineSource?: string;
    stale?: boolean;
  }[];
  pricingExpired?: boolean;
  storageLimits?: {
    maxStateBytes: number;
    receiptMaxBytes: number;
    resetEnabled: boolean;
  } | null;
  walletBalances?: WalletBalance[];
  walletDeposits?: WalletDeposit[];
  mode: string;
  customers?: Customer[];
  beneficiaries?: Beneficiary[];
  orders?: Order[];
  attempts?: Attempt[];
  refunds?: Refund[];
  discrepancies?: Discrepancy[];
  commissions?: Commission[];
  settlements?: Settlement[];
  batches?: Batch[];
  batchItems?: BatchItem[];
  pricingFixture?: Pricing;
  pricingCurrent?: import("./admin-models").PricingVersion;
  pricingHistory?: import("./admin-models").PricingVersion[];
  payoutProviders?: import("./admin-models").PayoutProvider[];
}
export interface Health {
  simulatedTopupsEnabled?: boolean;
  accessMode?: "public_demo";
  status: string;
  mode: string;
  persistence: string;
  realExecutionEnabled: boolean;
}
export const labels: Record<string, string> = {
  awaiting: "待入金",
  confirmed: "已确认",
  exception: "入金异常",
  pending: "待处理",
  recorded: "已登记",
  draft: "待准备",
  awaiting_approval: "待复核",
  approved: "已批准",
  sent: "已发送",
  unknown: "结果未知",
  failed: "确认失败",
  cancelled: "已取消",
  none: "未登记",
  uploaded: "回单已登记",
  verified: "已核验",
  suspended: "已暂停",
  requested: "待退款复核",
  valid: "通过",
  error: "校验失败",
  created: "已生成订单",
  open: "待处理",
  resolved: "已解决",
  available: "可结算",
  settled: "已入结算单",
  adjustment: "负向调整",
  hold: "观察期内",
  allocated: "已分配",
  frozen: "已冻结",
};
/** Presentation-only formatting. No numeric coercion, rounding, rates, or totals. */
export function money(value: string | undefined): string {
  if (!value) return "—";
  if (!/^-?\d+(\.\d+)?$/.test(value)) return value;
  const [whole, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + "." + trimmed.padEnd(2, "0")
  );
}
export function shortId(id: string) {
  return id.length > 16 ? id.slice(0, 8).toUpperCase() : id;
}
export function date(value: string) {
  return (
    new Date(value).toLocaleString("zh-CN", {
      hour12: false,
      timeZone: "UTC",
    }) + " UTC"
  );
}
export function symbol(currency: string) {
  return (
    (
      {
        CNY: "¥",
        USD: "$",
        USDT: "$",
        USDC: "$",
        EUR: "€",
        GBP: "£",
        MXN: "MX$",
        BRL: "R$",
      } as Record<string, string>
    )[currency] ?? currency
  );
}

/** Escape every output cell, including rejected CSV input and financial negatives. */
export function csvText(rows: string[][]): string {
  const cell = (value: string) =>
    '"' +
    (/^[\s\u0000-\u001f]*[=+@-]/.test(value) ? "'" + value : value).replaceAll(
      '"',
      '""',
    ) +
    '"';
  return rows.map((row) => row.map(cell).join(",")).join("\n");
}

/** Decimal ratio -> percentage label by moving the decimal point as text only. */
export function percentage(ratio: string): string {
  if (!/^\d+(\.\d+)?$/.test(ratio)) return ratio;
  const [whole, fraction = ""] = ratio.split(".");
  const digits = fraction.padEnd(2, "0");
  const integer = (whole + digits.slice(0, 2)).replace(/^0+(?=\d)/, "");
  const tail = digits.slice(2).replace(/0+$/, "");
  return integer + (tail ? "." + tail : "") + "%";
}

/** Presentation gate only; the hosted API also enforces maker authorization. */
export function canResetDemoSession(
  actor: ActorKey,
  persistence: string | undefined,
): boolean {
  return (
    (actor === "admin-demo" || actor === "maker-demo") &&
    persistence === "session-memory"
  );
}

/** Preserve user decimal strings; all pricing/rounding is performed by the API. */
export function quoteAmountInput(
  mode: "target_payout" | "total_deposit",
  value: string,
  currency: string,
) {
  return mode === "target_payout"
    ? { amountMode: mode, targetAmount: value, payoutCurrency: currency }
    : { amountMode: mode, sourceAmount: value };
}
export function validQuoteAmount(
  mode: "target_payout" | "total_deposit",
  value: string,
): boolean {
  return (
    (mode === "target_payout"
      ? /^(0|[1-9]\d{0,19})(\.\d{1,2})?$/
      : /^(0|[1-9]\d{0,19})(\.\d{1,6})?$/
    ).test(value) && /[1-9]/.test(value)
  );
}

/** Compare six-decimal server strings without converting monetary values to floats. */
export function decimalUnits(value: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(value))
    throw new Error("Invalid decimal amount");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * BigInt("1000000") + BigInt(fraction.padEnd(6, "0"));
}
export function hasWalletFunds(
  available: string | undefined,
  required: string,
): boolean {
  try {
    return decimalUnits(available ?? "0") >= decimalUnits(required);
  } catch {
    return false;
  }
}

export function batchErrorLabel(message: string): string {
  return (
    (
      {
        "Spreadsheet formula prefix rejected": "不接受公式前缀，请填写纯文本",
        "Invalid row fields": "字段格式有误，请对照模板检查",
        "Duplicate clientItemId": "本批次业务参考号重复",
        "Client item already imported for this customer":
          "该业务参考号已导入，避免重复提交",
        "Beneficiary not whitelisted": "收款账户不可用，或不属于当前客户",
        "Beneficiary unavailable or outside customer scope":
          "收款账户不存在、已停用，或不属于当前客户",
        "Recipient unavailable or belongs to another customer":
          "收款账户不存在、已停用，或不属于当前客户",
        "Invalid amount precision or value": "金额须大于 0，最多 6 位小数",
      } as Record<string, string>
    )[message] ?? message
  );
}

/** Saved recipients are usable after format validation; this is not bank verification. */
export function recipientUsable(status: string): boolean {
  return ["saved", "approved", "pending"].includes(status);
}

export function canQuickMockConfirm(order: Order): boolean {
  return (
    order.payoutProviderSnapshot?.scope === "official" &&
    order.payoutProviderSnapshot.status === "active" &&
    order.depositStatus === "confirmed" &&
    ["draft", "approved", "awaiting_approval"].includes(order.payoutStatus)
  );
}
