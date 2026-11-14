"use client";
import { useEffect, useState } from "react";
import type { Customer, Order } from "./models";
import { adminRead } from "./FinanceLedger";
import { adminOrderTasks } from "./experience-models";
export default function AdminTaskCenter({
  orders,
  customers,
  onFunds,
  onOrder,
  onReviewCustomers,
}: {
  orders: Order[];
  customers: Customer[];
  onFunds: (tab: string) => void;
  onOrder: (id: string) => void;
  onReviewCustomers: () => void;
}) {
  const [money, setMoney] = useState<any>(null),
    [funding, setFunding] = useState<any>(null),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    async function load() {
      const results = await Promise.allSettled([
        adminRead("admin/money", c.signal),
        adminRead("admin/funding", c.signal),
      ]);
      if (c.signal.aborted) return;
      if (results[0].status === "fulfilled") setMoney(results[0].value);
      if (results[1].status === "fulfilled") setFunding(results[1].value);
      setError(
        results.some((r) => r.status === "rejected")
          ? "部分资金待办暂未更新，可进入资金管理重试。"
          : "",
      );
    }
    void load();
    const t = setInterval(() => {
      if (!document.hidden) void load();
    }, 30000);
    return () => {
      c.abort();
      clearInterval(t);
    };
  }, []);
  const tasks = adminOrderTasks(orders);
  const pendingMoney = money?.pendingCounts
    ?.filter((r: any) => r.kind === "refund")
    .reduce((n: number, r: any) => n + Number(r.count), 0);
  const depositReviews = funding?.payments
    ?.filter((r: any) =>
      ["review", "creation_unknown", "partially_paid"].includes(r.status),
    )
    .reduce((n: number, r: any) => n + Number(r.count), 0);
  const cards = [
    {
      name: "提现待办",
      count: pendingMoney,
      action: () => onFunds("approvals"),
      detail: "审核申请与确认付款",
    },
    {
      name: "充值待核对",
      count: depositReviews,
      action: () => onFunds("deposits"),
      detail: "异常与少付记录",
    },
    {
      name: "结算待办",
      count: money?.pendingCounts
        ?.filter((r: any) => r.kind === "provider_settlement")
        .reduce((n: number, r: any) => n + Number(r.count), 0),
      action: () => onFunds("settlements"),
      detail: "服务商结算申请",
    },
    {
      name: "等待资金确认",
      count: tasks.waiting.length,
      action: () => tasks.waiting[0] && onOrder(tasks.waiting[0].id),
      detail: "核对后再安排付款",
    },
    {
      name: "可处理订单",
      count: tasks.ready.length,
      action: () => tasks.ready[0] && onOrder(tasks.ready[0].id),
      detail: "已满足资金条件",
    },
    {
      name: "订单待核实",
      count: tasks.review.length,
      action: () => tasks.review[0] && onOrder(tasks.review[0].id),
      detail: "优先确认处理结果",
    },
    {
      name: "超过24小时",
      count: tasks.overdue.length,
      action: () => tasks.overdue[0] && onOrder(tasks.overdue[0].id),
      detail: "未完成的订单",
    },
    {
      name: "客户待审核",
      count: customers.filter((c) => c.status === "pending").length,
      action: onReviewCustomers,
      detail: "查看资料与审核",
    },
  ];
  return (
    <section className="card task-center" aria-label="运营待办">
      <div className="card-heading">
        <div>
          <h2>今天需要处理</h2>
          <p className="muted small">资金与订单待办，每30秒更新</p>
        </div>
      </div>
      {error && <p role="status">{error}</p>}
      <div className="task-grid">
        {cards.map((c) => (
          <button
            key={c.name}
            onClick={c.action}
            disabled={c.count === undefined || c.count === 0}
            className="task-card"
          >
            <span>{c.name}</span>
            <strong>{c.count ?? "—"}</strong>
            <small>{c.detail}</small>
          </button>
        ))}
      </div>
    </section>
  );
}
