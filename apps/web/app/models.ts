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
  payoutCurrency: "CNY" | "USD";
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
  customerId: string;
  clientOrderId: string;
  quote: Quote;
  depositStatus: string;
  conversionStatus: string;
  payoutStatus: string;
  receiptStatus: string;
  receiptFileAvailable?: boolean;
  reconciled: boolean;
  createdAt: string;
  batchId?: string;
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
}
export interface Beneficiary {
  id: string;
  customerId: string;
  name: string;
  country: string;
  currency: "CNY" | "USD";
  accountMasked: string;
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
export interface Dashboard {
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
}
export interface Health {
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
  return currency === "CNY" ? "¥" : "$";
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
