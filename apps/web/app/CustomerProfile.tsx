"use client";
import { useContext } from "react";
import { WorkspaceContext } from "./workspace-context";
import { money, type WalletBalance } from "./models";
export default function CustomerProfile({
  customer,
  balances,
  orderCount,
  recipientCount,
}: {
  customer?: { id: string; kind: string; status: string };
  balances: WalletBalance[];
  orderCount: number;
  recipientCount: number;
}) {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) return null;
  const a = workspace.account,
    status = customer?.status;
  return (
    <section className="card customer-profile-detail" aria-label="用户详情">
      <h2>用户详情</h2>
      <dl className="details">
        {[
          ["账户名称", a.name],
          ["登录账号", a.username || a.email || "—"],
          ["用户编号", a.customerId || a.id],
          [
            "账户类型",
            (customer?.kind ?? a.kind) === "company" ? "企业账户" : "个人账户",
          ],
          [
            "账户状态",
            status === "approved"
              ? "正常"
              : status === "suspended"
                ? "已停用"
                : "待审核",
          ],
          [
            "注册时间",
            a.createdAt
              ? new Date(a.createdAt).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                  hour12: false,
                }) + " 北京时间"
              : "未记录",
          ],
          [
            "二次验证",
            workspace.securityStatus
              ? workspace.securityStatus.mfaEnabled
                ? "已开启"
                : "未开启"
              : "—",
          ],
          ["收款账户", `${recipientCount} 个`],
          ["结汇订单", `${orderCount} 笔`],
        ].map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h3>资金概览</h3>
      <div className="customer-profile-balances">
        {["USDT", "USDC"].map((currency) => {
          const b = balances.find(
            (b) => b.customerId === a.customerId && b.currency === currency,
          );
          return (
            <div key={currency}>
              <strong>{currency}</strong>
              <dl>
                <div>
                  <dt>可用余额</dt>
                  <dd>{money(b?.available ?? "0")}</dd>
                </div>
                <div>
                  <dt>冻结余额</dt>
                  <dd>{money(b?.frozen ?? "0")}</dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>
      <button
        className="button outline"
        onClick={() => workspace.openSecurity?.()}
      >
        账户安全
      </button>
    </section>
  );
}
