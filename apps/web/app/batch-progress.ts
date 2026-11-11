import type { BatchItem, Order } from "./models";
export function batchProgress(items: BatchItem[], orders: Order[]) {
  const result = {
    completed: 0,
    failed: 0,
    unknown: 0,
    processing: 0,
    invalid: 0,
  };
  for (const item of items) {
    if (item.status === "error") {
      result.invalid++;
      continue;
    }
    const order = orders.find((o) => o.id === item.orderId);
    if (order?.completionStatus === "completed") result.completed++;
    else if (order?.payoutStatus === "failed") result.failed++;
    else if (order?.payoutStatus === "unknown") result.unknown++;
    else result.processing++;
  }
  return result;
}
export function batchResultLabel(order?: Order) {
  if (order?.completionStatus === "completed") return "已完成";
  if (order?.payoutStatus === "failed") return "付款失败";
  if (order?.payoutStatus === "unknown") return "待确认 · 禁止重复付款";
  if (order?.payoutStatus === "sent") return "已登记 · 历史待复核";
  return "处理中";
}
