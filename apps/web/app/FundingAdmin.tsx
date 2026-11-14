"use client";
import { useEffect, useState } from "react";
import FinanceLedger from "./FinanceLedger";
import MoneyOperationsAdmin from "./MoneyOperationsAdmin";
import { moneyRequest } from "./money-api";
import { fundingStatus } from "./FundingDialog";
export default function FundingAdmin({
  onOpenOrder,
}: {
  onOpenOrder?: (id: string) => void;
}) {
  const [review, setReview] = useState<any>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [data, setData] = useState<any>(null),
    [error, setError] = useState("");
  async function load() {
    const r = await fetch("/workspace/api/admin/funding", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!r.ok) return;
    setData(await r.json());
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
      await moneyRequest("admin/funding/" + review.id + "/resolve", {
        decision:
          review.status === "creation_unknown" ? "link" : "accept_partial",
        note: String(f.get("note")),
        ...(review.status === "creation_unknown"
          ? { providerId: String(f.get("providerId")).trim() }
          : {}),
      });
      setReview(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReviewBusy(false);
    }
  }
  if (!data && !error)
    return (
      <>
        <FinanceLedger onOpenOrder={onOpenOrder} />
        <MoneyOperationsAdmin />
      </>
    );
  return (
    <>
      <FinanceLedger onOpenOrder={onOpenOrder} />
      <section className="card" style={{ padding: 24, marginTop: 20 }}>
        <div className="card-heading">
          <h2>充值与资金监控</h2>
          <button className="button outline" onClick={() => void load()}>
            刷新
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
        {data?.reconciliation?.map((r: any) => (
          <p key={r.currency}>
            {r.currency} 充值账务核对：
            {r.matches ? "一致" : "存在差异，请暂停资金操作并核查"}
          </p>
        ))}
        {!data?.records?.length && <p>暂无真实充值记录。</p>}
        {data?.records?.map((p: any) => (
          <div className="fund-record" key={p.id}>
            <div>
              <strong>{p.id}</strong>
              <small>
                {p.currency} · {fundingStatus(p.status)}
              </small>
            </div>
            <div>
              {p.credited_amount ?? p.requested_amount} {p.currency}
              {data.enabled &&
                ["creation_unknown", "review"].includes(p.status) &&
                !p.credited_amount && (
                  <button className="button text" onClick={() => setReview(p)}>
                    {p.status === "creation_unknown"
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
              {review.status === "creation_unknown"
                ? "关联 NOWPayments 支付记录"
                : "核对少付净额"}
            </h3>
            {review.status === "creation_unknown" ? (
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
              <input name="note" required minLength={3} maxLength={300} />
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
      <MoneyOperationsAdmin />
    </>
  );
}
