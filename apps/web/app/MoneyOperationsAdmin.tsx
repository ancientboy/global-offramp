"use client";
import { useEffect, useState, useRef } from "react";
import { money, date } from "./models";
import SelectField from "./SelectField";
import { moneyRequest, movementLabels } from "./money-api";
export default function MoneyOperationsAdmin({
  kind = "refund",
}: {
  kind?: "refund" | "provider_settlement";
}) {
  const [page, setPage] = useState(1);
  const [showHistory, setShowHistory] = useState(false);
  const createKey = useRef(crypto.randomUUID());
  const [providerId, setProviderId] = useState("");
  const [data, setData] = useState<any>(null),
    [report, setReport] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<any>(null),
    [create, setCreate] = useState(false),
    [currency, setCurrency] = useState("USDT");
  async function load() {
    const [d, r] = await Promise.all([
      moneyRequest(
        `admin/money?kind=${kind}&history=${showHistory}&page=${page}`,
      ),
      moneyRequest("admin/money/report"),
    ]);
    setData(d);
    setReport(r);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [kind, showHistory, page]);
  async function open(r: any) {
    setSelected(r);
    setCreate(false);
    try {
      const details = await moneyRequest("admin/money/" + r.id);
      setSelected((current: any) => (current?.id === r.id ? details : current));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function act(path: string, body: any) {
    setBusy(true);
    setError("");
    try {
      await moneyRequest(path, body);
      setSelected(null);
      setCreate(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>, kind: string) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    if (kind === "create")
      return act("admin/provider-settlements", {
        ...f,
        currency,
        network: "usdttrc20",
        idempotencyKey: createKey.current,
      });
    if (kind === "verify")
      return act("admin/money/" + selected.id + "/verify", {
        txid: String(f.txid).trim(),
        ...(f.logIndex !== "" ? { logIndex: Number(f.logIndex) } : {}),
      });
    return act("money-movements/" + selected.id + "/decision", f);
  }
  return (
    <section className="card money-admin">
      <div className="card-heading">
        <h2>{kind === "refund" ? "提现审批" : "服务商结算"}</h2>
        <div>
          {kind === "provider_settlement" && (
            <button
              className="button outline"
              onClick={() => {
                createKey.current = crypto.randomUUID();
                setProviderId(data?.payables?.[0]?.providerId ?? "");
                setCreate(true);
                setSelected(null);
              }}
            >
              新建服务商结算
            </button>
          )}
          <button
            className="button text"
            onClick={() => void load().catch((e) => setError(e.message))}
          >
            刷新
          </button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      <label className="history-toggle">
        <input
          type="checkbox"
          checked={showHistory}
          onChange={(e) => {
            setShowHistory(e.target.checked);
            setPage(1);
            setSelected(null);
          }}
        />
        显示历史申请
      </label>
      {report && (
        <details className="money-reconciliation">
          <summary>账务核对与汇总</summary>
          <div className="money-report-grid">
            {report.rows
              .filter((r: any) => ["USDT"].includes(r.currency))
              .map((r: any) => (
                <div key={r.currency}>
                  <strong>{r.currency}</strong>
                  <p>账面结算资产 {money(r.bookTreasury)}</p>
                  <p>待处理资金 {money(r.pendingMovements)}</p>
                  <p>可结算应付 {money(r.providerPayable)}</p>
                  <span>
                    {r.ledgerBalanced && r.depositsMatch && r.movementHoldsMatch
                      ? "账务核对一致"
                      : "存在账务差异，请核查"}
                  </span>
                </div>
              ))}
          </div>
          <p className="muted small">
            这是平台账务核对，外部钱包余额须另行核对。
            <a href="/workspace/api/admin/money/report?format=csv" download>
              导出核对报表
            </a>
          </p>
        </details>
      )}
      {data && !data.verification.usdttrc20.configured && (
        <p className="muted small">
          结算钱包地址待核实配置，链上付款核验暂不可用。
        </p>
      )}
      {create && (
        <form className="money-form" onSubmit={(e) => void submit(e, "create")}>
          <h3>新建服务商结算</h3>
          <label>
            服务商
            <SelectField
              name="providerId"
              required
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
            >
              {[
                ...new Map(
                  (data?.payables ?? []).map((p: any) => [p.providerId, p]),
                ).values(),
              ].map((p: any) => (
                <option key={p.providerId} value={p.providerId}>
                  {p.name}
                </option>
              ))}
            </SelectField>
          </label>
          <label>
            结算币种
            <SelectField
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option>USDT</option>
            </SelectField>
          </label>
          <p>
            网络：{currency === "USDT" ? "TRON · TRC20" : "Base"}
            。按当前应付余额冻结，不执行自动转账。
          </p>
          <p>
            该服务商可结算：
            {money(
              data?.payables?.find(
                (p: any) =>
                  p.providerId === providerId && p.currency === currency,
              )?.available ?? "0",
            )}{" "}
            {currency}
          </p>
          <label>
            金额
            <input
              name="amount"
              required
              inputMode="decimal"
              pattern="[0-9]+(\.[0-9]{1,6})?"
            />
          </label>
          <label>
            收款钱包地址
            <input
              name="destination"
              required
              maxLength={100}
              spellCheck={false}
            />
          </label>
          <label>
            结算说明
            <input name="reason" required minLength={3} maxLength={300} />
          </label>
          <button className="button" disabled={busy}>
            创建结算申请
          </button>
          <button
            type="button"
            className="button text"
            onClick={() => setCreate(false)}
          >
            取消
          </button>
        </form>
      )}
      {!data && !error && (
        <div
          className="loading-skeleton"
          role="status"
          aria-label="正在加载申请"
        />
      )}
      {data &&
        !data.records?.some(
          (r: any) =>
            r.kind === kind &&
            (showHistory || ["requested", "approved"].includes(r.status)),
        ) && <p>暂无{showHistory ? "相关申请" : "待办申请"}。</p>}
      {data?.records
        ?.filter(
          (r: any) =>
            r.kind === kind &&
            (showHistory || ["requested", "approved"].includes(r.status)),
        )
        .map((r: any) => (
          <button
            className="fund-record movement-row"
            key={r.id}
            onClick={() => void open(r)}
          >
            <span>
              <strong>{r.kind === "refund" ? "客户提现" : "服务商结算"}</strong>
              <small>{r.id}</small>
            </span>
            <span>
              <strong>
                {money(r.amount)} {r.currency}
              </strong>
              <small>
                {r.status === "approved"
                  ? "待转账确认"
                  : movementLabels[r.status]}
              </small>
            </span>
          </button>
        ))}
      {data && data.total > 100 && (
        <div className="actions">
          <button
            className="button outline"
            disabled={page <= 1}
            onClick={() => {
              setPage((p) => p - 1);
              setSelected(null);
            }}
          >
            上一页
          </button>
          <span>
            第{page}页 / 共{Math.ceil(data.total / 100)}页
          </span>
          <button
            className="button outline"
            disabled={page * 100 >= data.total}
            onClick={() => {
              setPage((p) => p + 1);
              setSelected(null);
            }}
          >
            下一页
          </button>
        </div>
      )}
      {selected && (
        <div className="money-detail">
          <h3>{selected.kind === "refund" ? "提现详情" : "结算详情"}</h3>
          <dl>
            <dt>金额</dt>
            <dd>
              {money(selected.amount)} {selected.currency}
            </dd>
            <dt>网络</dt>
            <dd>
              {selected.network === "usdttrc20" ? "TRON · TRC20" : "Base"}
            </dd>
            <dt>收款地址</dt>
            <dd className="money-address">{selected.destination}</dd>
            <dt>申请说明</dt>
            <dd>{selected.reason || "—"}</dd>
          </dl>
          {selected.status === "requested" && (
            <form
              className="money-form"
              onSubmit={(e) => void submit(e, "decision")}
            >
              <label>
                处理结果
                <SelectField name="action">
                  <option value="approve">审核通过，待手动转账</option>
                  <option value="reject">拒绝并释放冻结</option>
                </SelectField>
              </label>
              <label>
                审核说明
                <input name="note" required minLength={3} maxLength={300} />
              </label>
              <button className="button" disabled={busy}>
                确认审核
              </button>
            </form>
          )}
          {selected.status === "approved" && (
            <form
              className="money-form"
              onSubmit={(e) => void submit(e, "verify")}
            >
              <p>
                请在外部钱包手动转账至本申请的收款地址，再填写交易哈希并确认。系统只核对付款结果，不会发起转账。
              </p>
              <label>
                交易哈希
                <input name="txid" required maxLength={66} spellCheck={false} />
              </label>
              <details>
                <summary>高级选项</summary>
                <label>
                  转账事件序号（可选）
                  <input
                    name="logIndex"
                    type="number"
                    min={0}
                    max={2147483647}
                    placeholder="通常自动匹配，无需填写"
                  />
                </label>
              </details>
              <label className="money-confirm">
                <input type="checkbox" required disabled={busy} />
                我已在外部钱包完成转账，确认收款地址、网络及金额正确
              </label>
              <button className="button" disabled={busy}>
                {busy ? "正在核对付款…" : "确认已转账"}
              </button>
            </form>
          )}
          {selected.txid && (
            <p className="money-address">已核验交易：{selected.txid}</p>
          )}
          {!!selected.events?.length && (
            <details>
              <summary>处理记录</summary>
              {selected.events.map((e: any, i: number) => (
                <p key={i}>
                  {date(e.created_at)} · {e.actor_name} ·{" "}
                  {movementLabels[e.action] ?? e.action}：{e.note}
                </p>
              ))}
            </details>
          )}
          <button className="button text" onClick={() => setSelected(null)}>
            收起
          </button>
        </div>
      )}
    </section>
  );
}
