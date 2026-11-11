"use client";

import {
  ArrowRight,
  Bank,
  CheckCircle,
  FileText,
  ShieldWarning,
} from "@phosphor-icons/react";
import type { Order } from "./models";
import { matchesMerchantQueue, type MerchantQueue } from "./merchant-queues";
import "./merchant-overview.css";

export { matchesMerchantQueue } from "./merchant-queues";
export type { MerchantQueue } from "./merchant-queues";

const queues = [
  {
    key: "ready",
    title: "资金已就绪待付款",
    description: "核对收款信息，登记模拟付款",
    action: "查看待付款",
    icon: Bank,
  },
  {
    key: "unknown",
    title: "待核实",
    description: "先查询渠道结果，避免重复付款",
    action: "查看待核实",
    icon: ShieldWarning,
  },
  {
    key: "receipt",
    title: "已完成可补回单",
    description: "回单可选，不影响订单完成",
    action: "查看可补回单",
    icon: FileText,
  },
  {
    key: "reconcile",
    title: "历史待复核",
    description: "旧记录或差异需人工处理",
    action: "查看待复核",
    icon: CheckCircle,
  },
] as const;

export default function MerchantOverview({
  orders,
  onSelectQueue,
  selectedQueue,
}: {
  orders: Order[];
  onSelectQueue: (queue: MerchantQueue) => void;
  selectedQueue: string;
}) {
  const unknownCount = orders.filter((order) =>
    matchesMerchantQueue(order, "unknown"),
  ).length;
  const batches = new Set(
    orders.flatMap((order) => (order.batchId ? [order.batchId] : [])),
  );

  return (
    <section
      className="merchant-overview"
      aria-labelledby="merchant-overview-title"
    >
      <div className="merchant-overview-heading">
        <div>
          <span className="merchant-overview-eyebrow">
            平台运营台 · 模拟出款
          </span>
          <h2 id="merchant-overview-title">每笔业务，下一步都清楚</h2>
          <p>先处理未知结果；付款确认即完成，回单按需补充。</p>
        </div>
        <button
          type="button"
          className="merchant-overview-all"
          aria-pressed={selectedQueue === "all"}
          onClick={() => onSelectQueue("all")}
        >
          全部订单 <strong>{orders.length}</strong>
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>

      <div className="merchant-queue-grid" aria-label="按待办事项筛选订单">
        {queues.map(({ key, title, description, action, icon: Icon }) => {
          const count = orders.filter((order) =>
            matchesMerchantQueue(order, key),
          ).length;
          return (
            <button
              type="button"
              key={key}
              className={`merchant-queue-card${selectedQueue === key ? " is-selected" : ""}${key === "unknown" && count > 0 ? " has-attention" : ""}`}
              aria-pressed={selectedQueue === key}
              onClick={() => onSelectQueue(key)}
            >
              <span className="merchant-queue-top">
                <span className="merchant-queue-icon">
                  <Icon size={21} aria-hidden="true" />
                </span>
                <span>{title}</span>
              </span>
              <span className="merchant-queue-count">
                {count}
                <small>笔</small>
              </span>
              <span className="merchant-queue-description">{description}</span>
              <span className="merchant-queue-action">
                {action}
                <ArrowRight size={16} aria-hidden="true" />
              </span>
            </button>
          );
        })}
      </div>

      {unknownCount > 0 && (
        <div className="merchant-unknown-note" role="status">
          <ShieldWarning size={20} aria-hidden="true" />
          <p>
            <strong>{unknownCount} 笔付款结果待核实。</strong>
            核实前暂停重复付款与退款，请先查询渠道结果并登记证据。
          </p>
          <button type="button" onClick={() => onSelectQueue("unknown")}>
            优先处理
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
      )}

      <div className="merchant-workflow">
        <div className="merchant-workflow-label">
          <strong>处理路径</strong>
          <span>单人即可完成</span>
        </div>
        <ol>
          <li>
            <span className="merchant-workflow-step">1</span>
            <div>
              <strong>确认入金</strong>
              <span>核对到账与订单信息</span>
            </div>
          </li>
          <li>
            <span className="merchant-workflow-step">2</span>
            <div>
              <strong>核对 · 模拟确认</strong>
              <span>核对收款人、金额与执行方</span>
            </div>
          </li>
          <li>
            <span className="merchant-workflow-step">3</span>
            <div>
              <strong>已完成 · 回单可选</strong>
              <span>确认即完成；异常另行复核</span>
            </div>
          </li>
        </ol>
      </div>
      <div className="merchant-overview-footnote">
        <span>
          回单不影响完成与佣金计提。历史待复核及异常单独处理，退款等限制以订单详情为准。
        </span>
        <span>{batches.size} 个批次 · MOCK 演示，无真实资金执行</span>
      </div>
    </section>
  );
}
