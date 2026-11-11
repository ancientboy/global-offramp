import type { Batch, BatchItem, Beneficiary, Dashboard, Order } from "./models";
import { batchErrorLabel } from "./models";

export type CustomerOrderFilter =
  "all" | "processing" | "completed" | "attention";
export type CustomerOrderGroup =
  Exclude<CustomerOrderFilter, "all"> | "cancelled";
export type CustomerOrderState = {
  kind:
    | "completed"
    | "failed"
    | "unknown"
    | "review"
    | "deposit_exception"
    | "awaiting_deposit"
    | "processing"
    | "cancelled"
    | "unsubmitted"
    | "invalid"
    | "missing";
  group: CustomerOrderGroup;
  label: string;
  detail: string;
  tone: "good" | "bad" | "warn" | "neutral";
};

/** Receipt presence and payout.sent never establish business completion. */
export function customerOrderState(order: Order): CustomerOrderState {
  if (order.payoutStatus === "unknown")
    return {
      kind: "unknown",
      group: "attention",
      label: "结果待确认",
      detail: "禁止重复付款或重新提交，等待平台核实。",
      tone: "warn",
    };
  if (order.payoutStatus === "cancelled")
    return {
      kind: "cancelled",
      group: "cancelled",
      label: "已取消",
      detail: "订单已关闭，保留完整历史记录。",
      tone: "neutral",
    };
  if (order.payoutStatus === "failed")
    return {
      kind: "failed",
      group: "attention",
      label: "付款失败",
      detail: "请查看订单详情，等待平台处理。",
      tone: "bad",
    };
  if (order.completionStatus === "completed")
    return {
      kind: "completed",
      group: "completed",
      label: "已完成",
      detail: "平台已确认付款；回单可稍后提供。",
      tone: "good",
    };
  if (order.depositStatus === "exception")
    return {
      kind: "deposit_exception",
      group: "attention",
      label: "入金异常",
      detail: "请查看订单详情，等待平台核实入金。",
      tone: "bad",
    };
  if (
    order.completionStatus === "pending_review" ||
    order.payoutStatus === "sent"
  )
    return {
      kind: "review",
      group: "attention",
      label: "付款记录待复核",
      detail: "已登记付款，尚未确认完成，请勿重复付款。",
      tone: "warn",
    };
  if (order.depositStatus === "awaiting")
    return {
      kind: "awaiting_deposit",
      group: "processing",
      label: "待入金",
      detail: "等待入金确认后处理。",
      tone: "neutral",
    };
  if (order.payoutStatus === "awaiting_approval")
    return {
      kind: "processing",
      group: "processing",
      label: "付款待复核",
      detail: "平台正在复核付款。",
      tone: "warn",
    };
  if (order.payoutStatus === "approved")
    return {
      kind: "processing",
      group: "processing",
      label: "待付款",
      detail: "付款已获批准，等待平台处理。",
      tone: "neutral",
    };
  return {
    kind: "processing",
    group: "processing",
    label: "处理中",
    detail: "平台正在处理订单。",
    tone: "neutral",
  };
}

export function orderRecipient(
  order: Order,
  beneficiaries: Beneficiary[],
): Beneficiary | undefined {
  return beneficiaries.find(
    (b) =>
      b.id === order.quote.beneficiaryId && b.customerId === order.customerId,
  );
}

export function filterCustomerOrders(
  orders: Order[],
  beneficiaries: Beneficiary[],
  filter: CustomerOrderFilter,
  search: string,
): Order[] {
  const needle = search.trim().toLocaleLowerCase();
  return orders
    .filter((o) => {
      if (filter !== "all" && customerOrderState(o).group !== filter)
        return false;
      const recipient = orderRecipient(o, beneficiaries);
      return [
        o.id,
        o.orderNumber,
        o.clientOrderId,
        recipient?.name,
        recipient?.accountMasked,
        o.batchId,
      ]
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function customerOrderCounts(orders: Order[]) {
  const result = {
    all: orders.length,
    processing: 0,
    completed: 0,
    attention: 0,
  };
  for (const order of orders) {
    const group = customerOrderState(order).group;
    if (group !== "cancelled") result[group]++;
  }
  return result;
}

export type CustomerBatchRow = {
  key: string;
  rowNumber: number | undefined;
  reference: string;
  recipient: string;
  bank: string;
  account: string;
  targetAmount: string;
  targetCurrency: string;
  sourceAmount: string;
  sourceCurrency: string;
  item?: BatchItem;
  order?: Order;
  state: CustomerOrderState;
  errors: string[];
};

function importRowState(item: BatchItem): CustomerOrderState {
  if (item.orderId || item.status === "created")
    return {
      kind: "missing",
      group: "attention",
      label: "订单待核实",
      detail: "暂未找到对应订单，请联系平台确认，禁止重复提交。",
      tone: "warn",
    };
  if (item.status === "error" || item.errors.length)
    return {
      kind: "invalid",
      group: "attention",
      label: "导入失败",
      detail: "该行未生成订单，请检查错误信息。",
      tone: "bad",
    };
  return {
    kind: "unsubmitted",
    group: "processing",
    label: "待确认报价",
    detail: "已导入，尚未提交付款。",
    tone: "neutral",
  };
}

/** Only join orders and recipients belonging to this batch's customer. */
export function customerBatchRows(
  batch: Batch,
  data: Dashboard,
): CustomerBatchRow[] {
  const orders = (data.orders ?? []).filter(
    (o) => o.batchId === batch.id && o.customerId === batch.customerId,
  );
  const beneficiaries = data.beneficiaries ?? [];
  const items = (data.batchItems ?? []).filter((i) => i.batchId === batch.id);
  const rows: CustomerBatchRow[] = items.map((item, index) => {
    const order = orders.find((o) => o.id === item.orderId);
    const recipient = beneficiaries.find(
      (b) =>
        b.id === (order?.quote.beneficiaryId ?? item.beneficiaryId) &&
        b.customerId === batch.customerId,
    );
    return {
      key: item.id,
      rowNumber: item.rowNumber ?? index + 1,
      reference: item.clientItemId || "缺少业务参考号",
      recipient: item.recipientName || recipient?.name || "未识别收款人",
      bank: item.bankName ?? "",
      account: item.accountMasked || recipient?.accountMasked || "",
      targetAmount: order?.quote.payoutAmount ?? item.targetAmount ?? "",
      targetCurrency: order?.quote.payoutCurrency ?? item.targetCurrency ?? "",
      sourceAmount: order?.quote.sourceAmount ?? item.sourceAmount ?? "",
      sourceCurrency: order?.quote.sourceCurrency ?? item.sourceCurrency ?? "",
      item,
      order,
      state: order ? customerOrderState(order) : importRowState(item),
      errors: item.errors.map(batchErrorLabel),
    };
  });
  // Retain submitted orders even if an older import did not retain its source row.
  for (const order of orders.filter(
    (o) => !rows.some((row) => row.order?.id === o.id),
  )) {
    const recipient = orderRecipient(order, beneficiaries);
    rows.push({
      key: order.id,
      rowNumber: undefined,
      reference: order.clientOrderId,
      recipient: recipient?.name ?? "未记录收款人",
      bank: "",
      account: recipient?.accountMasked ?? "",
      targetAmount: order.quote.payoutAmount,
      targetCurrency: order.quote.payoutCurrency,
      sourceAmount: order.quote.sourceAmount,
      sourceCurrency: order.quote.sourceCurrency,
      order,
      state: customerOrderState(order),
      errors: [],
    });
  }
  return rows;
}

export function customerBatchSummary(rows: CustomerBatchRow[]) {
  const counts = {
    total: rows.length,
    completed: 0,
    processing: 0,
    failed: 0,
    unknown: 0,
    invalid: 0,
    unsubmitted: 0,
    cancelled: 0,
    review: 0,
  };
  for (const row of rows) {
    switch (row.state.kind) {
      case "completed":
        counts.completed++;
        break;
      case "failed":
        counts.failed++;
        break;
      case "unknown":
        counts.unknown++;
        break;
      case "invalid":
        counts.invalid++;
        break;
      case "unsubmitted":
        counts.unsubmitted++;
        break;
      case "cancelled":
        counts.cancelled++;
        break;
      case "missing":
      case "review":
      case "deposit_exception":
        counts.review++;
        break;
      default:
        counts.processing++;
    }
  }
  const attention = rows.some(
    (row) => row.state.group === "attention" || row.errors.length > 0,
  );
  const group: CustomerOrderGroup = attention
    ? "attention"
    : counts.completed === rows.length && rows.length > 0
      ? "completed"
      : counts.cancelled > 0 &&
          counts.completed + counts.cancelled === rows.length
        ? "cancelled"
        : "processing";
  const label = !rows.length
    ? "暂无明细"
    : attention
      ? "需处理"
      : group === "completed"
        ? "全部完成"
        : group === "cancelled"
          ? counts.cancelled === rows.length
            ? "全部取消"
            : "已结束 · 含取消"
          : counts.unsubmitted === rows.length
            ? "待确认报价"
            : counts.processing || counts.unsubmitted
              ? "处理中"
              : "已结束 · 含取消";
  return {
    ...counts,
    group,
    label,
    canResume:
      rows.some((r) => r.item?.status === "valid" && !r.errors.length) &&
      !rows.some(
        (r) => r.order || r.item?.orderId || r.item?.status === "created",
      ),
  };
}

export function batchMatchesSearch(
  batch: Batch,
  rows: CustomerBatchRow[],
  search: string,
) {
  const needle = search.trim().toLocaleLowerCase();
  return [
    batch.id,
    batch.clientBatchId,
    ...rows.flatMap((row) => [
      row.reference,
      row.recipient,
      row.account,
      row.order?.id,
      row.order?.orderNumber,
    ]),
  ]
    .join(" ")
    .toLocaleLowerCase()
    .includes(needle);
}

/** Export exact server decimal strings; downloadCSV handles formula-safe escaping. */
export function customerBatchExport(
  batch: Batch,
  rows: CustomerBatchRow[],
): string[][] {
  return [
    [
      "批次参考号",
      "导入行号",
      "业务参考号",
      "收款人",
      "银行",
      "掩码账户",
      "目标到账金额",
      "到账币种",
      "兑换本金",
      "本金币种",
      "订单号",
      "显示状态",
      "出款状态",
      "完成状态",
      "错误信息",
      "处理说明",
    ],
    ...rows.map((row) => [
      batch.clientBatchId,
      row.rowNumber?.toString() ?? "",
      row.reference,
      row.recipient,
      row.bank,
      row.account,
      row.targetAmount,
      row.targetCurrency,
      row.sourceAmount,
      row.sourceCurrency,
      row.order?.orderNumber ?? row.order?.id ?? "",
      row.state.label,
      row.order?.payoutStatus ?? "",
      row.order?.completionStatus ?? "",
      row.errors.join("；"),
      row.state.detail,
    ]),
  ];
}
