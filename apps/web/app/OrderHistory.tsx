"use client";
import { useState } from "react";
import type { Order, Customer, Beneficiary } from "./models";
import { date, money } from "./models";
import { Badge, Empty, Note, downloadCSV } from "./ui";
import {
  emptyHistoryFilters,
  filterHistory,
  type HistoryFilters,
} from "./history-models";
import "./order-history.css";

export default function OrderHistory({
  orders,
  customers,
  beneficiaries,
  persistence,
  onOpen,
}: {
  orders: Order[];
  customers: Customer[];
  beneficiaries: Beneficiary[];
  persistence?: string;
  onOpen: (id: string) => void;
}) {
  const [filters, setFilters] = useState<HistoryFilters>({
    ...emptyHistoryFilters,
  });
  const set = (key: keyof HistoryFilters, value: string) =>
    setFilters((old) => ({ ...old, [key]: value }));
  const rows = filterHistory(orders, filters, customers, beneficiaries);
  const exportRows = () =>
    downloadCSV("MOCK-orders-filtered.csv", [
      [
        "内部订单号",
        "客户",
        "状态",
        "创建时间 UTC",
        "登记付款时间 UTC",
        "本金",
        "资产",
        "服务费",
        "通道费",
        "到账金额",
        "法币",
        "出款方",
        "记录号类型",
        "MOCK内部记录号",
        "人工登记渠道参考号",
      ],
      ...rows.map((o) => [
        o.orderNumber ?? o.id,
        customers.find((c) => c.id === o.customerId)?.name ?? o.customerId,
        o.payoutStatus,
        o.createdAt,
        o.paymentConfirmation?.paidAt ?? "",
        o.quote.sourceAmount,
        o.quote.sourceCurrency,
        o.quote.serviceFee,
        o.quote.channelFee,
        o.quote.payoutAmount,
        o.quote.payoutCurrency,
        o.payoutProviderSnapshot?.name ?? "旧版本未记录",
        o.paymentConfirmation?.referenceKind === "mock_internal"
          ? "模拟内部记录，未外部核验"
          : "人工登记",
        o.paymentConfirmation?.internalRecordId ?? "",
        o.paymentConfirmation?.referenceKind === "mock_internal"
          ? ""
          : (o.paymentConfirmation?.providerReference ?? ""),
      ]),
    ]);
  return (
    <section className="card history-panel">
      <div className="card-heading">
        <h2>全部订单</h2>
        <button
          className="button outline"
          disabled={!rows.length}
          onClick={exportRows}
        >
          导出筛选结果
        </button>
      </div>
      <Note>
        {persistence === "d1_mock"
          ? "已登录账户的 MOCK 历史记录保存于服务端，刷新和实例重启不会清空。不同登录账户隔离。"
          : "当前仅显示本次演示会话内的全部订单。临时预览重启或会话到期后记录会清空。"}{" "}
        此列表独立于出款工作台，包含已付款和已取消订单。
      </Note>
      <div className="history-filters">
        <label className="history-search">
          搜索
          <input
            aria-label="历史订单搜索"
            placeholder="订单号、客户、收款人、模拟流水"
            value={filters.search}
            onChange={(e) => set("search", e.target.value)}
          />
        </label>
        <label>
          订单状态
          <select
            value={filters.status}
            onChange={(e) => set("status", e.target.value)}
          >
            <option value="all">所有状态</option>
            <option value="draft">待准备</option>
            <option value="awaiting_approval">待复核</option>
            <option value="approved">已批准</option>
            <option value="sent">已登记付款</option>
            <option value="unknown">结果待核实</option>
            <option value="failed">确认失败</option>
            <option value="cancelled">已取消</option>
          </select>
        </label>
        <label>
          用户 / 商户
          <select
            value={filters.customerId}
            onChange={(e) => set("customerId", e.target.value)}
          >
            <option value="all">全部客户</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.kind === "company" ? "商户" : "个人"}
              </option>
            ))}
          </select>
        </label>
        <label>
          币种
          <select
            value={filters.currency}
            onChange={(e) => set("currency", e.target.value)}
          >
            <option value="all">全部币种</option>
            {["USDT", "USDC", "CNY", "USD"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label>
          时间口径
          <select
            value={filters.timeField}
            onChange={(e) => set("timeField", e.target.value)}
          >
            <option value="createdAt">订单创建时间 UTC</option>
            <option value="paidAt">登记付款时间 UTC</option>
          </select>
        </label>
        <label>
          起始日期 UTC
          <input
            type="date"
            value={filters.from}
            onChange={(e) => set("from", e.target.value)}
          />
        </label>
        <label>
          结束日期 UTC
          <input
            type="date"
            value={filters.to}
            min={filters.from}
            onChange={(e) => set("to", e.target.value)}
          />
        </label>
        <button
          className="button text"
          onClick={() => setFilters({ ...emptyHistoryFilters })}
        >
          清除全部筛选
        </button>
      </div>
      <p className="muted small">
        显示 {rows.length} / {orders.length}{" "}
        笔。按付款时间筛选时不包含尚无付款时间的订单；导出与当前筛选一致。
      </p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>内部订单号 / 创建时间</th>
              <th>用户 / 收款人</th>
              <th>金额</th>
              <th>出款方</th>
              <th>状态</th>
              <th>登记付款时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <td>
                  <button className="order-link" onClick={() => onOpen(o.id)}>
                    {o.orderNumber ?? o.id}
                  </button>
                  <small>{date(o.createdAt)}</small>
                </td>
                <td>
                  {customers.find((c) => c.id === o.customerId)?.name ??
                    o.customerId}
                  <small>
                    {beneficiaries.find((b) => b.id === o.quote.beneficiaryId)
                      ?.name ?? o.quote.beneficiaryId}
                  </small>
                </td>
                <td className="numeric">
                  {money(o.quote.payoutAmount)} {o.quote.payoutCurrency}
                  <small>
                    {money(o.quote.totalDeposit)} {o.quote.sourceCurrency} 总额
                  </small>
                </td>
                <td>
                  {o.payoutProviderSnapshot?.name ?? "旧版本未记录"}
                  <small>
                    {o.payoutProviderSnapshot?.scope === "official"
                      ? "官方自营"
                      : "模拟合作出款方"}
                  </small>
                </td>
                <td>
                  <Badge status={o.payoutStatus} />
                </td>
                <td>
                  {o.paymentConfirmation?.paidAt
                    ? date(o.paymentConfirmation.paidAt)
                    : "未登记"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <Empty title="没有匹配的订单">
          调整条件或清除全部筛选，查看其它订单。
        </Empty>
      )}
    </section>
  );
}
