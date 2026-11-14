"use client";
import { useEffect, useState } from "react";
import { fundingStatus } from "./FundingDialog";
export default function FundingAdmin() {
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
  if (!data && !error) return null;
  return (
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
            <button className="button text" onClick={() => void recheck(p.id)}>
              重新核对
            </button>
          </div>
        </div>
      ))}
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
  );
}
