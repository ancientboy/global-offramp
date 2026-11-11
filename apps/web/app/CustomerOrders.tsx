"use client";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  DownloadSimple,
  Files,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import type { Dashboard, Order } from "./models";
import { date, money, shortId } from "./models";
import { Empty, Note, downloadCSV } from "./ui";
import PublishedReceipts from "./PublishedReceipts";
import {
  batchMatchesSearch,
  customerBatchExport,
  customerBatchRows,
  customerBatchSummary,
  customerOrderCounts,
  customerOrderState,
  filterCustomerOrders,
  orderRecipient,
  type CustomerOrderFilter,
  type CustomerOrderState,
} from "./customer-order-models";
import "./customer-orders.css";

export type CustomerOrdersProps = {
  /** The caller supplies only the authenticated customer's dashboard scope. */
  data: Dashboard;
  request: <T>(path: string) => Promise<T>;
  onDownload: (id: string, fileName: string) => Promise<void>;
  onOpen: (orderId: string) => void;
  onResumeBatch?: (batchId: string) => void;
};

const filters: { value: CustomerOrderFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "processing", label: "处理中" },
  { value: "completed", label: "已完成" },
  { value: "attention", label: "需处理" },
];

function Status({
  state,
  detail = false,
}: {
  state: CustomerOrderState;
  detail?: boolean;
}) {
  return (
    <div className="co-state">
      <span className={`badge ${state.tone}`}>{state.label}</span>
      {(detail || state.kind === "unknown") && (
        <small className={state.kind === "unknown" ? "co-warning" : ""}>
          {state.detail}
        </small>
      )}
    </div>
  );
}

export default function CustomerOrders({
  data,
  request,
  onDownload,
  onOpen,
  onResumeBatch,
}: CustomerOrdersProps) {
  const [mode, setMode] = useState<"orders" | "batches">("orders");
  const [filter, setFilter] = useState<CustomerOrderFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [receiptOrderId, setReceiptOrderId] = useState<string | null>(null);
  const orders = data.orders ?? [];
  const beneficiaries = data.beneficiaries ?? [];
  const batches = (data.batches ?? [])
    .map((batch) => {
      const rows = customerBatchRows(batch, data);
      return { batch, rows, summary: customerBatchSummary(rows) };
    })
    .sort((a, b) => b.batch.createdAt.localeCompare(a.batch.createdAt));
  const selectedBatch = batches.find((b) => b.batch.id === selectedBatchId);
  const visibleOrders = filterCustomerOrders(
    orders,
    beneficiaries,
    filter,
    search,
  );
  const visibleBatches = batches.filter(
    ({ batch, rows, summary }) =>
      (filter === "all" || summary.group === filter) &&
      batchMatchesSearch(batch, rows, search),
  );
  const counts =
    mode === "orders"
      ? customerOrderCounts(orders)
      : {
          all: batches.length,
          processing: batches.filter((b) => b.summary.group === "processing")
            .length,
          completed: batches.filter((b) => b.summary.group === "completed")
            .length,
          attention: batches.filter((b) => b.summary.group === "attention")
            .length,
        };
  const openBatch = (id: string) => {
    setSelectedBatchId(id);
    setReceiptOrderId(null);
  };
  const exportOrders = () =>
    downloadCSV("MOCK-订单记录.csv", [
      [
        "订单号",
        "创建时间 UTC",
        "收款人",
        "掩码账户",
        "到账金额",
        "到账币种",
        "稳定币总额",
        "资产币种",
        "显示状态",
        "出款状态",
        "完成状态",
        "处理说明",
        "批次编号",
      ],
      ...visibleOrders.map((o) => {
        const state = customerOrderState(o),
          recipient = orderRecipient(o, beneficiaries);
        return [
          o.orderNumber ?? o.id,
          o.createdAt,
          recipient?.name ?? "",
          recipient?.accountMasked ?? "",
          o.quote.payoutAmount,
          o.quote.payoutCurrency,
          o.quote.totalDeposit,
          o.quote.sourceCurrency,
          state.label,
          o.payoutStatus,
          o.completionStatus ?? "",
          state.detail,
          o.batchId ?? "",
        ];
      }),
    ]);
  const exportBatches = () =>
    downloadCSV("MOCK-批次记录.csv", [
      [
        "批次编号",
        "批次参考号",
        "创建时间 UTC",
        "状态",
        "总行数",
        "已完成",
        "处理中",
        "付款失败",
        "结果待确认",
        "导入失败",
        "待确认报价",
        "已取消",
        "待核实或复核",
      ],
      ...visibleBatches.map(({ batch, summary: s }) => [
        batch.id,
        batch.clientBatchId,
        batch.createdAt,
        s.label,
        ...[
          s.total,
          s.completed,
          s.processing,
          s.failed,
          s.unknown,
          s.invalid,
          s.unsubmitted,
          s.cancelled,
          s.review,
        ].map(String),
      ]),
    ]);
  const receiptOrder = (
    selectedBatch
      ? selectedBatch.rows.map((r) => r.order).filter((o): o is Order => !!o)
      : visibleOrders
  ).find((o) => o.id === receiptOrderId);
  const receipts = receiptOrder && (
    <section className="co-receipt-panel" aria-label="订单回单">
      <div className="co-heading">
        <div>
          <h3>订单回单</h3>
          <p>{receiptOrder.orderNumber ?? shortId(receiptOrder.id)}</p>
        </div>
        <button className="button text" onClick={() => setReceiptOrderId(null)}>
          收起回单
        </button>
      </div>
      <p className="co-caption">
        仅展示管理员已发布给此订单的回单副本。回单可稍后提供，不影响已确认的完成状态。
      </p>
      <PublishedReceipts
        key={receiptOrder.id}
        orderId={receiptOrder.id}
        request={request}
        onDownload={onDownload}
      />
    </section>
  );

  if (selectedBatch) {
    const { batch, rows, summary: s } = selectedBatch;
    return (
      <section className="customer-orders card co-batch-detail">
        <button
          className="co-back"
          onClick={() => {
            setSelectedBatchId(null);
            setReceiptOrderId(null);
          }}
        >
          <ArrowLeft size={17} />
          返回{mode === "batches" ? "批次列表" : "订单列表"}
        </button>
        <div className="co-heading">
          <div>
            <span className="co-eyebrow">批次详情</span>
            <h2>{batch.clientBatchId || shortId(batch.id)}</h2>
            <p>
              创建于 {date(batch.createdAt)} · {s.total} 行
            </p>
          </div>
          <button
            className="button outline"
            disabled={!rows.length}
            onClick={() =>
              downloadCSV(
                "MOCK-批次逐行结果.csv",
                customerBatchExport(batch, rows),
              )
            }
          >
            <DownloadSimple size={16} />
            导出逐行结果
          </button>
        </div>
        <div className="co-batch-metrics" aria-label="批次处理统计">
          <div>
            <span>已完成</span>
            <strong>
              {s.completed}
              <small> / {s.total}</small>
            </strong>
          </div>
          <div>
            <span>处理中</span>
            <strong>{s.processing}</strong>
          </div>
          <div className={s.failed ? "co-metric-danger" : ""}>
            <span>付款失败</span>
            <strong>{s.failed}</strong>
          </div>
          <div className={s.unknown ? "co-metric-warning" : ""}>
            <span>结果待确认</span>
            <strong>{s.unknown}</strong>
          </div>
        </div>
        {!!(s.invalid + s.unsubmitted + s.cancelled + s.review) && (
          <p className="co-caption co-extra-counts">
            导入失败 {s.invalid} · 待确认报价 {s.unsubmitted} · 已取消{" "}
            {s.cancelled} · 待核实或复核 {s.review}
          </p>
        )}
        {s.unknown > 0 && (
          <Note danger>
            有 {s.unknown}{" "}
            行付款结果未知。禁止重复付款或重新提交，等待平台核实；回单中的文字不会改变处理结果。
          </Note>
        )}
        {s.canResume && onResumeBatch && (
          <div className="co-resume">
            <div>
              <strong>这个批次尚未提交付款</strong>
              <p>返回兑换核对有效行并确认报价；导入失败的行不会参与付款。</p>
            </div>
            <button className="button" onClick={() => onResumeBatch(batch.id)}>
              继续确认报价
              <ArrowRight size={16} />
            </button>
          </div>
        )}
        <div className="co-table-wrap">
          <table className="co-table co-detail-table">
            <thead>
              <tr>
                <th>行号 / 业务参考号</th>
                <th>收款人</th>
                <th>金额</th>
                <th>处理结果</th>
                <th>
                  <span className="co-sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td data-label="行 / 参考号">
                    <strong>
                      {row.rowNumber ? `第 ${row.rowNumber} 行` : "关联订单"}
                    </strong>
                    <small>{row.reference}</small>
                  </td>
                  <td data-label="收款人">
                    <strong>{row.recipient}</strong>
                    {(row.bank || row.account) && (
                      <small>
                        {[row.bank, row.account].filter(Boolean).join(" · ")}
                      </small>
                    )}
                  </td>
                  <td data-label="金额" className="numeric">
                    {row.targetAmount ? (
                      <>
                        <strong>
                          {money(row.targetAmount)} {row.targetCurrency}
                        </strong>
                        <small>目标到账</small>
                      </>
                    ) : row.sourceAmount ? (
                      <>
                        <strong>
                          {money(row.sourceAmount)} {row.sourceCurrency}
                        </strong>
                        <small>兑换本金 · 到账待报价</small>
                      </>
                    ) : (
                      <span className="muted">未填写有效金额</span>
                    )}
                  </td>
                  <td data-label="结果">
                    <Status state={row.state} detail />
                    {row.errors.length > 0 && (
                      <ul className="co-row-errors">
                        {row.errors.map((error, i) => (
                          <li key={i}>{error}</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="co-row-actions">
                    {row.order && (
                      <>
                        <button
                          className="order-link"
                          onClick={() => onOpen(row.order!.id)}
                        >
                          查看订单
                        </button>
                        <button
                          className="co-receipt-link"
                          aria-expanded={receiptOrderId === row.order.id}
                          onClick={() =>
                            setReceiptOrderId((id) =>
                              id === row.order!.id ? null : row.order!.id,
                            )
                          }
                        >
                          回单
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length && (
          <Empty title="暂无批次明细">
            当前未返回逐行数据，请稍后刷新。不要重新提交同一批次。
          </Empty>
        )}
        {receipts}
        <section className="co-receipt-panel" aria-label="本商户批次回单">
          <h3>本商户批次回单</h3>
          <p className="co-caption">
            仅展示管理员发布给当前商户及本批次的回单。请以上方逐行处理结果为准。
          </p>
          <PublishedReceipts
            key={batch.id}
            batchId={batch.id}
            request={request}
            onDownload={onDownload}
          />
        </section>
      </section>
    );
  }

  return (
    <section className="customer-orders card" aria-label="客户订单记录">
      <div className="co-heading">
        <div>
          <h2>订单记录</h2>
          <p>查看处理进度、逐笔结果与回单。</p>
        </div>
        <button
          className="button outline"
          disabled={
            mode === "orders" ? !visibleOrders.length : !visibleBatches.length
          }
          onClick={mode === "orders" ? exportOrders : exportBatches}
        >
          <DownloadSimple size={16} />
          导出记录
        </button>
      </div>
      <div className="co-controls">
        <div className="co-view-switch" role="group" aria-label="记录视图">
          <button
            aria-pressed={mode === "orders"}
            onClick={() => {
              setMode("orders");
              setReceiptOrderId(null);
            }}
          >
            逐笔订单 <span>{orders.length}</span>
          </button>
          <button
            aria-pressed={mode === "batches"}
            onClick={() => {
              setMode("batches");
              setReceiptOrderId(null);
            }}
          >
            <Files size={16} />
            批次 <span>{batches.length}</span>
          </button>
        </div>
        <label className="co-search">
          <MagnifyingGlass size={17} />
          <span className="co-sr-only">
            搜索{mode === "orders" ? "订单" : "批次"}
          </span>
          <input
            type="search"
            placeholder={
              mode === "orders"
                ? "搜索订单号 / 收款人"
                : "搜索批次 / 订单 / 收款人"
            }
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <div className="co-filters" role="group" aria-label="状态筛选">
        {filters.map(({ value, label }) => (
          <button
            key={value}
            aria-pressed={filter === value}
            onClick={() => {
              setFilter(value);
              setReceiptOrderId(null);
            }}
          >
            {label}
            <span>{counts[value]}</span>
          </button>
        ))}
      </div>
      <p className="co-caption co-results">
        显示 {mode === "orders" ? visibleOrders.length : visibleBatches.length}{" "}
        {mode === "orders" ? "笔" : "个批次"} · 全部记录包含已取消
        {mode === "batches" ? "及导入失败的批次" : "订单"}，回单不改变付款状态。
      </p>
      {mode === "orders" ? (
        <>
          <div className="co-table-wrap">
            <table className="co-table">
              <thead>
                <tr>
                  <th>订单 / 创建时间</th>
                  <th>收款人</th>
                  <th>到账金额</th>
                  <th>状态</th>
                  <th>
                    <span className="co-sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleOrders.map((o) => {
                  const recipient = orderRecipient(o, beneficiaries),
                    batch = batches.find(
                      (b) =>
                        b.batch.id === o.batchId &&
                        b.batch.customerId === o.customerId,
                    );
                  return (
                    <tr key={o.id}>
                      <td data-label="订单">
                        <button
                          className="order-link"
                          onClick={() => onOpen(o.id)}
                        >
                          {o.orderNumber ?? shortId(o.id)}
                        </button>
                        <small>{date(o.createdAt)}</small>
                        {batch && (
                          <button
                            className="co-batch-link"
                            onClick={() => openBatch(batch.batch.id)}
                          >
                            <Files size={13} />
                            {batch.batch.clientBatchId}
                          </button>
                        )}
                      </td>
                      <td data-label="收款人">
                        <strong>
                          {recipient?.name ?? shortId(o.quote.beneficiaryId)}
                        </strong>
                        <small>{recipient?.accountMasked ?? ""}</small>
                      </td>
                      <td data-label="到账金额" className="numeric">
                        <strong>
                          {money(o.quote.payoutAmount)} {o.quote.payoutCurrency}
                        </strong>
                        <small>
                          稳定币总额 {money(o.quote.totalDeposit)}{" "}
                          {o.quote.sourceCurrency}
                        </small>
                      </td>
                      <td data-label="状态">
                        <Status state={customerOrderState(o)} />
                      </td>
                      <td className="co-row-actions">
                        <button
                          className="order-link"
                          onClick={() => onOpen(o.id)}
                        >
                          查看详情
                        </button>
                        <button
                          className="co-receipt-link"
                          aria-expanded={receiptOrderId === o.id}
                          onClick={() =>
                            setReceiptOrderId((id) =>
                              id === o.id ? null : o.id,
                            )
                          }
                        >
                          回单
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!visibleOrders.length && (
            <Empty title={orders.length ? "没有匹配的订单" : "还没有订单"}>
              {orders.length
                ? "试试其他状态或收款人，也可以清除筛选。"
                : "提交兑换后，可在这里查看订单进度。导入但未提交的记录请查看批次。"}
            </Empty>
          )}
          {receipts}
        </>
      ) : (
        <div className="co-batch-list">
          {visibleBatches.map(({ batch, summary: s }) => (
            <button
              className="co-batch-card"
              key={batch.id}
              onClick={() => openBatch(batch.id)}
            >
              <div className="co-batch-icon">
                <Files size={22} />
              </div>
              <div className="co-batch-main">
                <strong>{batch.clientBatchId || shortId(batch.id)}</strong>
                <span>
                  {date(batch.createdAt)} · {s.total} 行
                </span>
                <div className="co-batch-outcomes">
                  <span>已完成 {s.completed}</span>
                  <span>处理中 {s.processing}</span>
                  {s.failed > 0 && (
                    <span className="co-error-text">付款失败 {s.failed}</span>
                  )}
                  {s.unknown > 0 && (
                    <span className="co-warning">
                      结果待确认 {s.unknown} · 禁止重复付款
                    </span>
                  )}
                  {s.invalid > 0 && (
                    <span className="co-error-text">导入失败 {s.invalid}</span>
                  )}
                  {s.unsubmitted > 0 && <span>待确认报价 {s.unsubmitted}</span>}
                  {s.review > 0 && <span>待核实或复核 {s.review}</span>}
                  {s.cancelled > 0 && <span>已取消 {s.cancelled}</span>}
                </div>
              </div>
              <span
                className={`badge ${s.group === "completed" ? "good" : s.group === "attention" ? "warn" : "neutral"}`}
              >
                {s.label}
              </span>
              <ArrowRight className="co-batch-arrow" size={18} />
            </button>
          ))}
          {!visibleBatches.length && (
            <Empty title={batches.length ? "没有匹配的批次" : "还没有批次记录"}>
              {batches.length
                ? "试试其他状态、批次号或收款人。"
                : "批量导入后，所有行的处理结果都会保留在这里。"}
            </Empty>
          )}
        </div>
      )}
      {(search || filter !== "all") && (
        <button
          className="button text co-clear"
          onClick={() => {
            setSearch("");
            setFilter("all");
          }}
        >
          清除筛选
        </button>
      )}
      <p className="co-footnote">MOCK 演示记录，不代表真实银行付款。</p>
    </section>
  );
}
