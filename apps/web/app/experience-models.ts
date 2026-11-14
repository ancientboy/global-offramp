import type { Order } from "./models";
export function displayDate(value: string) {
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) +
        " 北京时间"
    : "—";
}
export function providerQueue(o: {
  canRecordPayment: boolean;
  payoutStatus: string;
}) {
  if (o.payoutStatus === "unknown") return "unknown";
  if (o.canRecordPayment) return "ready";
  if (["draft", "approved", "awaiting_approval"].includes(o.payoutStatus))
    return "waiting";
  return o.payoutStatus;
}
export function adminOrderTasks(orders: Order[], now = Date.now()) {
  const active = orders.filter(
    (o) => !["sent", "cancelled", "failed"].includes(o.payoutStatus),
  );
  return {
    waiting: active.filter(
      (o) =>
        ["draft", "approved", "awaiting_approval"].includes(o.payoutStatus) &&
        (o.depositStatus !== "confirmed" ||
          (o.fundingSource === "wallet" &&
            o.walletFundingStatus !== "reserved")),
    ),
    ready: active.filter(
      (o) =>
        ["draft", "approved", "awaiting_approval"].includes(o.payoutStatus) &&
        o.depositStatus === "confirmed" &&
        (o.fundingSource !== "wallet" || o.walletFundingStatus === "reserved"),
    ),
    review: orders.filter(
      (o) =>
        o.payoutStatus === "unknown" ||
        o.depositStatus === "exception" ||
        o.completionStatus === "pending_review",
    ),
    overdue: active.filter((o) => now - Date.parse(o.createdAt) >= 86400000),
  };
}
export function recentWithdrawalAddresses(rows: any[], currency: string) {
  const network = currency === "USDT" ? "usdttrc20" : "usdcbase";
  return [
    ...new Set(
      rows
        .filter(
          (r) =>
            r.kind === "refund" &&
            r.currency === currency &&
            r.network === network &&
            r.status === "completed" &&
            typeof r.destination === "string",
        )
        .map((r) => r.destination as string),
    ),
  ].slice(0, 5);
}
