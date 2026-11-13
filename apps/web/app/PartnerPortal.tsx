"use client";
import { useContext, useEffect, useState } from "react";
import { WorkspaceContext } from "./workspace-context";
import { Badge, downloadCSV } from "./ui";
import {
  date,
  money,
  percentage,
  decimalUnits,
  type Commission,
  type Settlement,
} from "./models";
type Customer = {
  alias: string;
  displayName: string;
  kind: string;
  status: string;
  registeredAt: string;
};
type Data = {
  partner: { id: string; name: string; inviteUrl: string };
  customers: Customer[];
  commissions: Commission[];
  settlements: Settlement[];
};
function total(rows: Commission[], currency: string, eligibility?: string) {
  const n = rows
    .filter(
      (c) =>
        c.currency === currency &&
        (!eligibility || c.eligibility === eligibility),
    )
    .reduce(
      (sum, c) =>
        sum +
        (c.value.startsWith("-")
          ? -decimalUnits(c.value.slice(1))
          : decimalUnits(c.value)),
      0n,
    );
  const v = n < 0n ? -n : n;
  return (
    (n < 0n ? "-" : "") +
    String(v / 1000000n) +
    "." +
    String(v % 1000000n).padStart(6, "0")
  );
}
export default function PartnerPortal() {
  const workspace = useContext(WorkspaceContext)!;
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState("overview");
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
      if (!r.ok) throw Error("伙伴资料暂不可用，请联系管理员或稍后重试。");
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
  async function copy() {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.partner.inviteUrl);
      setNotice("邀请链接已复制，可发送给客户注册。");
    } catch {
      setNotice("请选中下方邀请链接复制。");
    }
  }
  function exportRows() {
    if (!data) return;
    downloadCSV("伙伴佣金明细.csv", [
      ["客户别名", "计佣服务费", "币种", "比例", "佣金", "状态", "观察期结束"],
      ...data.commissions.map((c) => [
        c.customerAlias ?? "",
        c.base,
        c.currency,
        c.rate,
        c.value,
        c.eligibility ?? c.state,
        c.eligibleAt,
      ]),
    ]);
  }
  return (
    <main className="partner-portal">
      <header className="provider-top">
        <div>
          <span className="admin-eyebrow">汇途 · 推广伙伴</span>
          <h1>{data?.partner.name ?? workspace.account.name}</h1>
          <p>邀请客户、跟踪注册与佣金记录</p>
        </div>
        <div className="actions">
          <button
            className="button outline"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? "读取中…" : "刷新"}
          </button>
          <button
            className="button text"
            disabled={busy}
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
      {notice && (
        <p role="status" className="note">
          {notice}
        </p>
      )}
      {data && (
        <>
          <section className="card partner-invitation">
            <div>
              <h2>专属邀请链接</h2>
              <p>客户通过此链接完成新账号注册后，自动归属于您。</p>
            </div>
            <div className="partner-link">
              <input
                aria-label="专属邀请链接"
                readOnly
                value={data.partner.inviteUrl}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button className="button" onClick={() => void copy()}>
                复制链接
              </button>
            </div>
          </section>
          <nav className="partner-tabs" aria-label="伙伴功能">
            {[
              ["overview", "概览"],
              ["customers", "我的客户"],
              ["commissions", "佣金明细"],
              ["settlements", "结算记录"],
            ].map(([id, name]) => (
              <button
                key={id}
                className={tab === id ? "active" : ""}
                onClick={() => setTab(id)}
              >
                {name}
              </button>
            ))}
          </nav>
          {tab === "overview" && (
            <>
              <section className="partner-counts">
                <div className="card">
                  <span>已注册客户</span>
                  <strong>{data.customers.length}</strong>
                </div>
                <div className="card">
                  <span>待审核客户</span>
                  <strong>
                    {
                      data.customers.filter((c) => c.status === "pending")
                        .length
                    }
                  </strong>
                </div>
                <div className="card">
                  <span>佣金记录</span>
                  <strong>{data.commissions.length}</strong>
                </div>
              </section>
              <section className="card">
                <h2>佣金概览</h2>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>币种</th>
                        <th>累计计提</th>
                        <th>观察期内</th>
                        <th>可结算</th>
                        <th>待核实冻结</th>
                      </tr>
                    </thead>
                    <tbody>
                      {["USDT", "USDC"].map((currency) => (
                        <tr key={currency}>
                          <td>{currency}</td>
                          <td>{money(total(data.commissions, currency))}</td>
                          <td>
                            {money(total(data.commissions, currency, "hold"))}
                          </td>
                          <td>
                            {money(
                              total(data.commissions, currency, "available"),
                            )}
                          </td>
                          <td>
                            {money(total(data.commissions, currency, "frozen"))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="muted small">
                  订单完成后按锁定的服务费返佣规则计提；退款和异常会调整可结算状态。
                </p>
              </section>
            </>
          )}
          {tab === "customers" && (
            <section className="card">
              <div className="card-heading">
                <h2>我的客户</h2>
                <Badge>{data.customers.length} 位</Badge>
              </div>
              {data.customers.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>客户</th>
                        <th>别名</th>
                        <th>类型</th>
                        <th>审核状态</th>
                        <th>注册时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.customers.map((c) => (
                        <tr key={c.alias}>
                          <td>{c.displayName}</td>
                          <td>{c.alias}</td>
                          <td>{c.kind === "company" ? "企业" : "个人"}</td>
                          <td>
                            <Badge status={c.status}>
                              {c.status === "pending"
                                ? "待审核"
                                : c.status === "approved"
                                  ? "已通过"
                                  : "已暂停"}
                            </Badge>
                          </td>
                          <td>{date(c.registeredAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="provider-empty">
                  <h3>暂无注册客户</h3>
                  <p>通过专属邀请链接注册的客户会显示在这里。</p>
                </div>
              )}
            </section>
          )}
          {tab === "commissions" && (
            <section className="card">
              <div className="card-heading">
                <h2>佣金明细</h2>
                <button
                  className="button outline"
                  disabled={!data.commissions.length}
                  onClick={exportRows}
                >
                  导出明细
                </button>
              </div>
              {data.commissions.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>客户别名</th>
                        <th>计佣服务费</th>
                        <th>比例</th>
                        <th>佣金</th>
                        <th>状态</th>
                        <th>观察期结束</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.commissions.map((c) => (
                        <tr key={c.id}>
                          <td>{c.customerAlias}</td>
                          <td>
                            {money(c.base)} {c.currency}
                          </td>
                          <td>{percentage(c.rate)}</td>
                          <td>
                            {money(c.value)} {c.currency}
                          </td>
                          <td>
                            <Badge status={c.eligibility ?? c.state} />
                          </td>
                          <td>{date(c.eligibleAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="provider-empty">
                  <h3>暂无佣金记录</h3>
                  <p>已归属客户完成符合规则的订单后，将生成佣金记录。</p>
                </div>
              )}
            </section>
          )}
          {tab === "settlements" && (
            <section className="card">
              <h2>结算记录</h2>
              {data.settlements.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>月份</th>
                        <th>币种</th>
                        <th>金额</th>
                        <th>状态</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.settlements.map((s) => (
                        <tr key={s.id}>
                          <td>{s.month}</td>
                          <td>{s.currency}</td>
                          <td>{money(s.amount)}</td>
                          <td>
                            <Badge status={s.status} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="provider-empty">
                  <h3>暂无结算记录</h3>
                  <p>管理员确认的结算记录会显示在这里。</p>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
