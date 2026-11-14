"use client";
import { useEffect, useState } from "react";
import { useViewState } from "./view-state";
import FinanceLedger from "./FinanceLedger";
import MoneyOperationsAdmin from "./MoneyOperationsAdmin";
import { moneyRequest } from "./money-api";
import { fundingStatus } from "./FundingDialog";
export default function FundingAdmin({
  onOpenOrder,
  initialTab,
}: {
  onOpenOrder?: (id: string) => void;
  initialTab?: string;
}) {
  const [tab, setTab] = useViewState("funds-tab", initialTab ?? "approvals");
  const [review, setReview] = useState<any>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [data, setData] = useState<any>(null),
    [error, setError] = useState("");
  async function load() {
    const r = await fetch("/workspace/api/admin/funding", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!r.ok) throw Error("充值监控暂不可用。");
    setData(await r.json());
    setError("");
  }
  useEffect(() => {
    void load().catch(() => setError("充值监控暂不可用。"));
  }, []);
  async function recheck(id: string) {
    setError("");
    try {
      const r = await fetch(
        "/workspace/api/admin/funding/" + encodeURIComponent(id) + "/recheck",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      if (!r.ok) throw Error("核对未完成，请检查账户安全验证或服务状态。");
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function resolve(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setReviewBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await moneyRequest(
        "admin/funding/" + review.id + "/resolve",
        review.source === "direct_tron"
          ? {
              decision: "assign_transfer",
              txid: String(f.get("txid")).trim(),
              logIndex: Number(f.get("logIndex")),
              note: String(f.get("note")),
            }
          : {
              decision:
                review.status === "creation_unknown"
                  ? "link"
                  : "accept_partial",
              note: String(f.get("note")),
              ...(review.status === "creation_unknown"
                ? { providerId: String(f.get("providerId")).trim() }
                : {}),
            },
      );
      setReview(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReviewBusy(false);
    }
  }
  return (
    <>
      <nav className="workspace-tabs" aria-label="资金管理分类">
        {[
          ["approvals", "提现审批"],
          ["ledger", "资金流水"],
          ["deposits", "充值监控"],
          ["settlements", "服务商结算"],
        ].map(([id, label]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === "approvals" && <MoneyOperationsAdmin kind="refund" />}
      {tab === "settlements" && (
        <MoneyOperationsAdmin kind="provider_settlement" />
      )}
      {tab === "ledger" && <FinanceLedger onOpenOrder={onOpenOrder} />}
      <div hidden={tab !== "deposits"}>
        <section className="card" style={{ padding: 24, marginTop: 20 }}>
          <div className="card-heading">
            <h2>充值与资金监控</h2>
            <button
              className="button outline"
              onClick={() =>
                void load().catch(() => setError("充值监控暂不可用。"))
              }
            >
              刷新
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
          {data?.receiver && (
            <p>
              固定收款地址：<code>{data.receiver}</code>
            </p>
          )}
          {data?.scan && (
            <p>
              链上扫描：{new Date(data.scan.checked_at).toLocaleString("zh-CN")}{" "}
              ·{" "}
              {Date.now() - new Date(data.scan.checked_at).getTime() < 120000
                ? "正常"
                : "连接待恢复"}
            </p>
          )}
          {!!data?.unmatched?.length && (
            <details>
              <summary>待归属链上收款（{data.unmatched.length}）</summary>
              {data.unmatched.map((e: any) => (
                <p key={e.txid + e.log_index}>
                  {e.amount} USDT · {e.txid} · 日志序号 {e.log_index}
                </p>
              ))}
              <p>
                请先核实付款人和订单，再在对应订单中关联交易。同笔收款只能入账一次。
              </p>
            </details>
          )}
          {data?.reconciliation
            ?.filter((r: any) => r.currency === "USDT")
            .map((r: any) => (
              <p key={r.currency}>
                {r.currency} 充值账务核对：
                {r.matches ? "一致" : "存在差异，请暂停资金操作并核查"}
              </p>
            ))}
          {!data && !error && <p role="status">正在加载充值记录…</p>}
          {data && !data.records?.length && <p>暂无真实充值记录。</p>}
          {data?.records?.map((p: any) => (
            <div className="fund-record" key={p.id}>
              <div>
                <strong>{p.id}</strong>
                <small>
                  {p.currency} · {fundingStatus(p.status)}
                </small>
              </div>
              <div>
                {p.credited_amount ?? p.pay_amount ?? p.requested_amount}{" "}
                {p.currency}
                {p.cost_quote && (
                  <small>
                    预估费用 {p.cost_quote.estimatedCost} · 预计到账{" "}
                    {p.cost_quote.estimatedNet} {p.currency}
                  </small>
                )}
                {data.enabled &&
                  (p.source === "direct_tron" ||
                    ["creation_unknown", "review"].includes(p.status)) &&
                  !p.credited_amount && (
                    <button
                      className="button text"
                      onClick={() => setReview(p)}
                    >
                      {p.source === "direct_tron"
                        ? "关联链上收款"
                        : p.status === "creation_unknown"
                          ? "关联支付记录"
                          : "核对少付净额"}
                    </button>
                  )}
                <button
                  className="button text"
                  onClick={() => void recheck(p.id)}
                >
                  重新核对
                </button>
              </div>
            </div>
          ))}
          {review && (
            <form className="money-form" onSubmit={(e) => void resolve(e)}>
              <h3>
                {review.source === "direct_tron"
                  ? "关联链上收款"
                  : review.status === "creation_unknown"
                    ? "关联 NOWPayments 支付记录"
                    : "核对少付净额"}
              </h3>
              {review.source === "direct_tron" ? (
                <>
                  <label>
                    交易哈希
                    <input
                      name="txid"
                      required
                      pattern="[a-f0-9]{64}"
                      maxLength={64}
                    />
                  </label>
                  <label>
                    日志序号
                    <input
                      name="logIndex"
                      type="number"
                      min="0"
                      step="1"
                      required
                    />
                  </label>
                  <p>
                    核实付款人归属后按实际收款金额入账，不补齐差额。此操作无法撤销。
                  </p>
                </>
              ) : review.status === "creation_unknown" ? (
                <label>
                  NOWPayments 支付编号
                  <input
                    name="providerId"
                    required
                    pattern="[0-9]{1,30}"
                    maxLength={30}
                  />
                </label>
              ) : (
                <p>只接受官方已结算的同币种净额，不按申请金额补齐余额。</p>
              )}
              <label>
                核对说明
                <input name="note" required minLength={10} maxLength={300} />
              </label>
              <button className="button" disabled={reviewBusy}>
                确认核对
              </button>
              <button
                type="button"
                className="button text"
                onClick={() => setReview(null)}
              >
                取消
              </button>
            </form>
          )}
          {!!data?.alerts?.length && (
            <details>
              <summary>异常记录（{data.alerts.length}）</summary>
              {data.alerts.map((a: any) => (
                <p key={a.kind + a.resource_id}>
                  {a.resource_id} · {a.kind}
                </p>
              ))}
            </details>
          )}
        </section>
      </div>
    </>
  );
}
