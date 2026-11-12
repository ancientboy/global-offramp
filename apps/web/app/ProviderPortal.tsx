"use client";
import { useContext, useEffect, useState } from "react";
import { WorkspaceContext } from "./workspace-context";
import { Badge } from "./ui";
import { date, money } from "./models";
type Data = {
  provider: { id: string; name: string; routes: string[] };
  orders: {
    id: string;
    orderNumber: string;
    createdAt: string;
    payoutCurrency: string;
    payoutAmount: string;
    payoutStatus: string;
    receiptStatus: string;
    recipient: null | { name: string; country: string; accountMasked: string };
  }[];
};
export default function ProviderPortal() {
  const workspace = useContext(WorkspaceContext)!;
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/workspace/api/dashboard", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (r.status === 401) {
        workspace.expired();
        return;
      }
      if (!r.ok)
        throw Error("暂时无法读取服务商订单，请联系管理员或稍后重试。");
      setData(await r.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  return (
    <main className="provider-portal">
      <header className="provider-top">
        <div>
          <span className="admin-eyebrow">汇途 · 出款服务商</span>
          <h1>{data?.provider.name ?? workspace.account.name}</h1>
          <p>查看分配给您的出款订单</p>
        </div>
        <div className="actions">
          <button
            className="button outline"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? "读取中…" : "刷新订单"}
          </button>
          <button
            className="button text"
            onClick={() =>
              void workspace
                .logout()
                .catch(() => setError("退出失败，请重试。"))
            }
          >
            退出登录
          </button>
        </div>
      </header>
      {error && (
        <p role="alert" className="note danger">
          {error}
        </p>
      )}
      {data && (
        <>
          <section className="provider-summary">
            <div className="card">
              <span>所属服务商</span>
              <strong>{data.provider.name}</strong>
            </div>
            <div className="card">
              <span>支持币种</span>
              <strong>{data.provider.routes.join(" · ")}</strong>
            </div>
            <div className="card">
              <span>分配订单</span>
              <strong>{data.orders.length}</strong>
            </div>
          </section>
          <section className="card">
            <div className="card-heading">
              <h2>出款订单</h2>
              <Badge>{data.orders.length} 笔</Badge>
            </div>
            {data.orders.length ? (
              <div className="provider-orders">
                <table>
                  <thead>
                    <tr>
                      <th>订单</th>
                      <th>收款人</th>
                      <th>出款金额</th>
                      <th>付款状态</th>
                      <th>回单</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.orders.map((o) => (
                      <tr key={o.id}>
                        <td>
                          {o.orderNumber}
                          <small>{date(o.createdAt)}</small>
                        </td>
                        <td>
                          {o.recipient?.name ?? "—"}
                          <small>{o.recipient?.accountMasked ?? "—"}</small>
                        </td>
                        <td>
                          {money(o.payoutAmount)} {o.payoutCurrency}
                        </td>
                        <td>
                          <Badge status={o.payoutStatus} />
                        </td>
                        <td>
                          <Badge status={o.receiptStatus} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="provider-empty">
                <h3>暂无分配订单</h3>
                <p>管理员将订单分配至您的服务商后，会显示在这里。</p>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
