"use client";
import { useEffect, useState } from "react";
import SelectField from "./SelectField";
import FinanceLedger, {
  adminRead,
  exact,
  FinanceTotals,
} from "./FinanceLedger";
import { financeDate as date } from "./FinanceLedger";
const labels: Record<string, string> = {
  approved: "正常",
  pending: "待审核",
  suspended: "受限",
};
export default function AdminCustomers({
  onOpenOrder,
  onOpenRecipient,
}: {
  onOpenOrder: (id: string) => void;
  onOpenRecipient: (id: string) => void;
}) {
  const [q, setQ] = useState(""),
    [status, setStatus] = useState(""),
    [kind, setKind] = useState(""),
    [applied, setApplied] = useState({ q: "", status: "", kind: "" }),
    [page, setPage] = useState(1),
    [refresh, setRefresh] = useState(0),
    [data, setData] = useState<any>(null),
    [selected, setSelected] = useState(""),
    [detail, setDetail] = useState<any>(null),
    [error, setError] = useState(""),
    [detailError, setDetailError] = useState(""),
    [loading, setLoading] = useState(true);
  const query = new URLSearchParams({
    ...applied,
    page: String(page),
    limit: "20",
  }).toString();
  useEffect(() => {
    const c = new AbortController();
    setLoading(true);
    setError("");
    void adminRead("admin/customers?" + query, c.signal)
      .then(setData)
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!c.signal.aborted) setLoading(false);
      });
    return () => c.abort();
  }, [query, refresh]);
  useEffect(() => {
    setDetail(null);
    setDetailError("");
    if (!selected) return;
    const c = new AbortController();
    void adminRead("admin/customers/" + encodeURIComponent(selected), c.signal)
      .then(setDetail)
      .catch((e) => {
        if (!c.signal.aborted) setDetailError(e.message);
      });
    return () => c.abort();
  }, [selected, refresh]);
  const p = detail?.customer;
  return (
    <>
      <section className="card finance-ledger" aria-label="用户与资金">
        <header className="card-heading">
          <div>
            <h2>用户与资金</h2>
            <p className="muted small">
              查看所有客户账号、资金余额、收款账户及业务记录。
            </p>
          </div>
          <button
            className="button outline"
            onClick={() => setRefresh((v) => v + 1)}
          >
            刷新用户
          </button>
        </header>
        <form
          className="finance-filters"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied({ q, status, kind });
            setPage(1);
            setRefresh((v) => v + 1);
          }}
        >
          <label className="finance-search">
            搜索用户
            <input
              value={q}
              maxLength={120}
              onChange={(e) => setQ(e.target.value)}
              placeholder="姓名、邮箱、登录账号或用户编号"
            />
          </label>
          <label>
            用户状态
            <SelectField
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">全部状态</option>
              <option value="approved">正常</option>
              <option value="pending">待审核</option>
              <option value="suspended">受限</option>
              <option value="disabled">登录已停用</option>
            </SelectField>
          </label>
          <label>
            用户类型
            <SelectField value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">全部类型</option>
              <option value="personal">个人</option>
              <option value="company">企业</option>
            </SelectField>
          </label>
          <button className="button" disabled={loading}>
            查询用户
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
        {loading ? (
          <p role="status">正在加载用户…</p>
        ) : (
          !error &&
          data && (
            <>
              <p className="muted small">
                共 {data.total} 位用户 · 数据截至 {date(data.asOf)}
              </p>
              <div className="finance-records">
                {data.records.map((c: any) => (
                  <button
                    className="finance-row finance-user-row"
                    key={c.id}
                    onClick={() => setSelected(c.id)}
                    aria-pressed={selected === c.id}
                  >
                    <span>
                      <strong>{c.name}</strong>
                      <small>{c.email || c.username || c.id}</small>
                    </span>
                    <span>
                      <strong>
                        {c.kind === "company" ? "企业" : "个人"} ·{" "}
                        {labels[c.status] ?? c.status}
                      </strong>
                      <small>
                        {c.enabled === false
                          ? "登录已停用"
                          : c.enabled === null
                            ? "尚未绑定登录账号"
                            : "登录正常"}{" "}
                        · {c.orderCount} 笔订单
                      </small>
                    </span>
                    <span>
                      {c.balances.map((b: any) => (
                        <small key={b.currency}>
                          <strong>
                            {b.currency} {exact(b.available)}
                          </strong>{" "}
                          可用 · {exact(b.frozen)} 冻结
                        </small>
                      ))}
                    </span>
                    <span className="finance-open">查看用户详情 →</span>
                  </button>
                ))}
              </div>
              {!data.total && (
                <p className="finance-empty">暂无符合条件的用户。</p>
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
                  第 {page} / {Math.max(1, Math.ceil(data.total / data.limit))}{" "}
                  页
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
      {selected && (
        <section className="card finance-ledger" aria-label="用户资金详情">
          <header className="card-heading">
            <h2>{p ? `${p.name} · 用户详情` : "用户详情"}</h2>
            <button className="button text" onClick={() => setSelected("")}>
              收起用户详情
            </button>
          </header>
          {detailError ? (
            <p role="alert">{detailError}</p>
          ) : !p ? (
            <p role="status">正在加载详情…</p>
          ) : (
            <>
              <dl className="finance-facts">
                {[
                  ["用户编号", p.id],
                  ["登录账号", p.email || p.username || "尚未绑定"],
                  ["用户类型", p.kind === "company" ? "企业" : "个人"],
                  ["业务状态", labels[p.status] ?? p.status],
                  [
                    "登录状态",
                    p.enabled === null
                      ? "尚未绑定"
                      : p.enabled
                        ? "正常"
                        : "已停用",
                  ],
                  ["注册时间", p.createdAt ? date(p.createdAt) : "未记录"],
                  ["最近登录", p.lastLogin ? date(p.lastLogin) : "未记录"],
                  ["验证器", p.mfaEnabled ? "已绑定" : "未绑定"],
                  ["推广归属", p.partnerName || "无"],
                  [
                    "订单情况",
                    `${p.orderCount} 笔 / 已完成 ${p.completedOrderCount} 笔`,
                  ],
                ].map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
              <h3>当前资金</h3>
              <div className="finance-totals">
                {p.balances.map((b: any) => (
                  <div className="finance-total" key={b.currency}>
                    <strong>{b.currency}</strong>
                    <dl>
                      {[
                        ["available", "可用余额"],
                        ["orderHeld", "结汇订单冻结"],
                        ["withdrawalHeld", "提现冻结"],
                        ["total", "钱包资金合计"],
                      ].map(([k, label]) => (
                        <div key={k}>
                          <dt>{label}</dt>
                          <dd>{exact(b[k])}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
              <p className="muted small">
                钱包资金合计为可用余额与冻结金额之和；已支出金额见下方历史记录。
              </p>
              <h3>累计资金情况</h3>
              <FinanceTotals rows={p.summary} />
              <h3>收款账户（{detail.recipients.length}）</h3>
              <div className="finance-recipients">
                {detail.recipients.map((b: any) => (
                  <div key={b.id}>
                    <strong>
                      {b.name} · {b.currency}
                    </strong>
                    <p>
                      {b.country} · {b.bankName || b.method || "收款账户"} ·{" "}
                      {b.accountMasked}
                    </p>
                    {b.method && (
                      <button
                        className="button text"
                        onClick={() => onOpenRecipient(b.id)}
                      >
                        查看收款资料
                      </button>
                    )}
                    <small>
                      {b.status === "approved"
                        ? "已审核"
                        : b.status === "saved"
                          ? "已保存"
                          : b.status === "suspended"
                            ? "受限"
                            : "待审核"}
                    </small>
                  </div>
                ))}
              </div>
              {!detail.recipients.length && <p>尚无收款账户。</p>}
            </>
          )}
        </section>
      )}
      {p && (
        <FinanceLedger key={p.id} customerId={p.id} onOpenOrder={onOpenOrder} />
      )}
    </>
  );
}
