import type { Order } from "./models";

export type MerchantQueue =
  "ready" | "unknown" | "receipt" | "reconcile" | "all";

/** Presentation queues only. API checks and refund restrictions still govern actions. */
export function matchesMerchantQueue(
  order: Order,
  queue: MerchantQueue,
): boolean {
  switch (queue) {
    case "ready":
      return (
        order.depositStatus === "confirmed" &&
        ["draft", "failed", "approved", "awaiting_approval"].includes(
          order.payoutStatus,
        )
      );
    case "unknown":
      return order.payoutStatus === "unknown";
    case "receipt":
      return order.payoutStatus === "sent" && order.receiptStatus === "none";
    case "reconcile":
      return (
        order.payoutStatus === "sent" &&
        !order.reconciled &&
        order.completionStatus !== "completed"
      );
    case "all":
      return true;
    default:
      return false;
  }
}
