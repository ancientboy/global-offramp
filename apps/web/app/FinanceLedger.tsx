"use client";
import { useEffect, useState } from "react";
import { useViewState } from "./view-state";
import SelectField from "./SelectField";
export function financeDate(value: string) {
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) +
        " 北京时间"
    : "—";
}
const date = financeDate;
import "./admin-finance.css";
export const financeKindLabels: Record<string, string> = {
  deposit: "充值",
  simulated_deposit: "模拟充值",
  withdrawal: "提现",
  exchange: "结汇",
  order_refund: "订单退款",
  provider_settlement: "服务商结算",
  other: "其他账务",
};
export const financeStatusLabels: Record<string, string> = {
  pending: "待处理",
  completed: "已完成",
  review: "待核对",
  failed: "未完成",
  cancelled: "已取消",
  rejected: "已拒绝",
};
export const exact = (n: unknown) =>
  n == null || n === ""
    ? "—"
    : String(n)
        .replace(/(\.\d*?)0+$/, "$1")
        .replace(/\.$/, "");
export async function adminRead(path: string, signal?: AbortSignal) {
  const r = await fetch("/workspace/api/" + path, {
    credentials: "same-origin",
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  if (!r.ok)
    throw Error(
      r.status === 403
        ? "无权查看这些资料。"
        : "资料暂时无法加载，请稍后重试。",
    );
  return r.json();
}
export function FinanceTotals({ rows }: { rows: any[] }) {
  return (
    <div className="finance-totals">
      {rows.map((r) => (
        <div className="finance-total" key={r.currency}>
          <strong>{r.currency}</strong>
          <dl>
            {[
              ["deposits", "已入账充值"],
              ["withdrawals", "已完成提现"],
              ["exchangeSpend", "已完成结汇支出"],
              ["fees", "已记账净手续费"],
              ["refunds", "已完成订单退款"],
              ["providerSettlements", "已完成服务商结算"],
              ["simulatedDeposits", "模拟充值"],
            ]
              .filter(
                ([k]) =>
                  k !== "simulatedDeposits" ||
                  !/^0(?:\.0+)?$/.test(r[k] ?? "0"),
              )
              .map(([k, label]) => (
                <div key={k}>
                  <dt>{label}</dt>
                  <dd>{exact(r[k])}</dd>
                </div>
              ))}
          </dl>
        </div>
      ))}
    </div>
  );
}
export default function FinanceLedger({
  customerId = "",
  onOpenOrder,
}: {
  customerId?: string;
  onOpenOrder?: (id: string) => void;
}) {
  const [filters, setFilters] = useViewState("ledger-filters:" + customerId, {
      q: "",
      kind: "",
      status: "",
      currency: "",
      from: "",
      to: "",
    }),
    [applied, setApplied] = useViewState(
      "ledger-applied:" + customerId,
      filters,
    ),
    [page, setPage] = useViewState("ledger-page:" + customerId, 1),
    [refresh, setRefresh] = useState(0),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [exporting, setExporting] = useState(false),
    [expanded, setExpanded] = useViewState("ledger-expanded:" + customerId, "");
  const params = new URLSearchParams({
    q: applied.q,
    kind: applied.kind,
    status: applied.status,
    currency: applied.currency,
    customerId,
    page: String(page),
    limit: "25",
  });
  if (applied.from)
    params.set(
      "from",
      new Date(applied.from + "T00:00:00+08:00").toISOString(),
    );
  if (applied.to)
    params.set(
      "to",
      new Date(
        new Date(applied.to + "T00:00:00+08:00").getTime() + 86400000,
      ).toISOString(),
    );
  const query = params.toString();
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError("");
    // Expanded records remain tied to the retained query.
    void adminRead("admin/finance/transactions?" + query, c.signal)
      .then(setData)
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [query, refresh]);
  async function download() {
    setExporting(true);
    setError("");
    try {
      const p = new URLSearchParams(query);
      p.set("format", "csv");
      const r = await fetch("/workspace/api/admin/finance/transactions?" + p, {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!r.ok)
        throw Error(
          r.status === 413
            ? "明细超过一万笔，请缩小日期或用户范围后导出。"
            : "导出失败，请稍后重试。",
        );
      const url = URL.createObjectURL(await r.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = "financial-transactions.csv";
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  return (
    <section className="card finance-ledger" aria-label="统一资金流水">
      <header className="card-heading">
        <div>
          <h2>资金流水</h2>
          <p className="muted small">
            充值、提现与结汇的逐笔记录；汇总按币种分别计算。
          </p>
        </div>
        <button
          className="button outline"
          onClick={() => setRefresh((v) => v + 1)}
        >
          刷新流水
        </button>
      </header>
      <form
        className="finance-filters"
        onSubmit={(e) => {
          e.preventDefault();
          if (filters.from && filters.to && filters.from > filters.to) {
            setError("结束日期不能早于开始日期。");
            return;
          }
          setApplied({ ...filters });
          setPage(1);
          setRefresh((v) => v + 1);
        }}
      >
        <label className="finance-search">
          搜索用户或业务单号
          <input
            value={filters.q}
            maxLength={120}
            placeholder="姓名、邮箱、账号、单号或交易哈希"
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          />
        </label>
        <label>
          业务类型
          <SelectField
            value={filters.kind}
            onChange={(e) => setFilters({ ...filters, kind: e.target.value })}
          >
            <option value="">全部类型</option>
            {Object.entries(financeKindLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </SelectField>
        </label>
        <label>
          币种
          <SelectField
            value={filters.currency}
            onChange={(e) =>
              setFilters({ ...filters, currency: e.target.value })
            }
          >
            <option value="">全部币种</option>
            {["USDT", "USDC", "CNY", "USD", "EUR", "GBP", "MXN", "BRL"].map(
              (c) => (
                <option key={c}>{c}</option>
              ),
            )}
          </SelectField>
        </label>
        <label>
          处理状态
          <SelectField
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          >
            <option value="">全部状态</option>
            {Object.entries(financeStatusLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </SelectField>
        </label>
        <label>
          开始日期（北京时间）
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
          />
        </label>
        <label>
          结束日期（北京时间）
          <input
            type="date"
            value={filters.to}
            min={filters.from}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
          />
        </label>
        <div className="finance-actions">
          <button className="button" disabled={loading}>
            查询流水
          </button>
          <button
            className="button text"
            type="button"
            onClick={() => {
              const empty = {
                q: "",
                kind: "",
                status: "",
                currency: "",
                from: "",
                to: "",
              };
              setFilters(empty);
              setApplied(empty);
              setPage(1);
              setRefresh((v) => v + 1);
            }}
          >
            重置筛选
          </button>
          <button
            className="button outline"
            type="button"
            onClick={() => void download()}
            disabled={loading || exporting}
          >
            {exporting ? "正在导出…" : "导出筛选明细"}
          </button>
        </div>
      </form>
      {error && <p role="alert">{error}</p>}
      {loading ? (
        <p role="status">正在加载资金流水…</p>
      ) : (
        !error &&
        data && (
          <>
            <FinanceTotals rows={data.summary} />
            <p className="muted small">
              共 {data.total} 笔 · 数据截至 {date(data.asOf)}
              。汇总只累计已完成金额，待处理申请单独显示。
            </p>
            <div className="finance-records">
              {data.records.map((r: any) => (
                <article className="finance-record" key={r.kind + ":" + r.id}>
                  <button
                    className="finance-row"
                    onClick={() => setExpanded(expanded === r.id ? "" : r.id)}
                    aria-expanded={expanded === r.id}
                  >
                    <span>
                      <strong>{financeKindLabels[r.kind]}</strong>
                      <small>{r.reference || r.id}</small>
                    </span>
                    <span>
                      <strong>
                        {r.customerName ||
                          r.party ||
                          r.customerId ||
                          "平台账务"}
                      </strong>
                      <small>
                        {r.email || r.username || r.customerId || "—"}
                      </small>
                    </span>
                    <span>
                      <strong>
                        {exact(r.amount)} {r.currency}
                      </strong>
                      <small>
                        {r.payoutAmount
                          ? `${exact(r.payoutAmount)} ${r.payoutCurrency}`
                          : r.network || "—"}
                      </small>
                    </span>
                    <span>
                      <strong>{financeStatusLabels[r.status]}</strong>
                      <small>{r.at ? date(r.at) : "时间未记录"}</small>
                    </span>
                  </button>
                  {expanded === r.id && (
                    <div className="finance-detail">
                      <dl className="finance-facts">
                        <div>
                          <dt>业务编号</dt>
                          <dd>{r.id}</dd>
                        </div>
                        {r.reference && (
                          <div>
                            <dt>
                              {r.kind === "deposit"
                                ? "支付服务编号"
                                : r.kind === "exchange"
                                  ? "结汇订单号"
                                  : "业务参考号"}
                            </dt>
                            <dd>{r.reference}</dd>
                          </div>
                        )}
                        <div>
                          <dt>用户编号</dt>
                          <dd>{r.customerId || "—"}</dd>
                        </div>
                        <div>
                          <dt>实际充值或完成金额</dt>
                          <dd>
                            {r.netAmount == null
                              ? "尚未完成"
                              : `${exact(r.netAmount)} ${r.currency}`}
                          </dd>
                        </div>
                        {r.kind === "exchange" && (
                          <>
                            <div>
                              <dt>结汇本金</dt>
                              <dd>
                                {exact(r.principal)} {r.currency}
                              </dd>
                            </div>
                            <div>
                              <dt>客户汇率</dt>
                              <dd>{exact(r.exchangeRate)}</dd>
                            </div>
                            <div>
                              <dt>报价服务费</dt>
                              <dd>
                                {exact(r.serviceFee)} {r.currency}
                              </dd>
                            </div>
                            <div>
                              <dt>报价渠道费</dt>
                              <dd>
                                {exact(r.channelFee)} {r.currency}
                              </dd>
                            </div>
                          </>
                        )}
                        <div>
                          <dt>已记账净手续费</dt>
                          <dd>
                            {exact(r.bookedFees)} {r.currency}
                          </dd>
                        </div>
                        {r.destination && (
                          <div>
                            <dt>收款地址</dt>
                            <dd>{r.destination}</dd>
                          </div>
                        )}
                        {r.txid && (
                          <div>
                            <dt>
                              {r.kind === "exchange"
                                ? "付款参考号"
                                : "交易哈希"}
                            </dt>
                            <dd>{r.txid}</dd>
                          </div>
                        )}
                      </dl>
                      {r.orderId && onOpenOrder && (
                        <button
                          className="button text"
                          onClick={() => onOpenOrder(r.orderId)}
                        >
                          查看关联订单
                        </button>
                      )}
                      <h4>记账与余额变化</h4>
                      {!r.postings.length ? (
                        <p className="muted">尚无记账记录。</p>
                      ) : (
                        r.postings.map((p: any) => (
                          <details className="finance-posting" key={p.id}>
                            <summary>
                              {date(p.at)} · {p.key}
                            </summary>
                            {p.walletChanges.map((w: any, i: number) => (
                              <p key={i}>
                                钱包可用余额：{exact(w.before)} →{" "}
                                {exact(w.after)} {p.currency}（变动{" "}
                                {exact(w.change)}）
                              </p>
                            ))}
                            <div className="finance-table-wrap">
                              <table>
                                <thead>
                                  <tr>
                                    <th>科目</th>
                                    <th>币种</th>
                                    <th>借方</th>
                                    <th>贷方</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {p.lines.map((l: any, i: number) => (
                                    <tr key={i}>
                                      <td>{l.account}</td>
                                      <td>{l.currency}</td>
                                      <td>{exact(l.debit)}</td>
                                      <td>{exact(l.credit)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </details>
                        ))
                      )}
                    </div>
                  )}
                </article>
              ))}
            </div>
            {!data.total && (
              <p className="finance-empty">暂无符合条件的流水。</p>
            )}
            <div className="finance-pagination">
              <button
                className="button outline"
                disabled={page === 1}
                onClick={() => setPage((p) => p - 1)}
              >
                上一页
              </button>
              <span>
                第 {page} / {Math.max(1, Math.ceil(data.total / data.limit))} 页
              </span>
              <button
                className="button outline"
                disabled={page * data.limit >= data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
            </div>
          </>
        )
      )}
    </section>
  );
}
