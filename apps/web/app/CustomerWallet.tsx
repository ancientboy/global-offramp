"use client";
import { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  Lock,
  Plus,
} from "@phosphor-icons/react";
import {
  date,
  money,
  type WalletBalance,
  type WalletDeposit,
  type Order,
} from "./models";
import { Badge, Empty } from "./ui";

export default function CustomerWallet({
  balances,
  deposits,
  orders,
  customerId,
  locked,
  resumeDraft,
  initialCurrency,
  onTopup,
  onExchange,
  onOrder,
}: {
  balances: WalletBalance[];
  deposits: WalletDeposit[];
  orders: Order[];
  customerId: string;
  locked: boolean;
  resumeDraft: boolean;
  initialCurrency: string;
  onTopup: (currency: string) => void;
  onExchange: (currency: string) => void;
  onOrder: (id: string) => void;
}) {
  const [currency, setCurrency] = useState(initialCurrency);
  const [history, setHistory] = useState(false);
  const [historyType, setHistoryType] = useState("deposits");
  const balance = balances.find(
    (b) => b.customerId === customerId && b.currency === currency,
  );
  const credits = deposits
    .filter((d) => d.customerId === customerId && d.currency === currency)
    .slice()
    .reverse();
  const funded = orders
    .filter(
      (o) =>
        o.customerId === customerId &&
        o.fundingSource === "wallet" &&
        o.quote.sourceCurrency === currency,
    )
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <section className="customer-wallet">
      {history && (
        <button
          className="button text back-link"
          onClick={() => setHistory(false)}
        >
          <ArrowLeft size={17} /> 返回钱包
        </button>
      )}
      <div className="wallet-section-heading">
        <h2>{history ? "资金记录" : "我的资产"}</h2>
        {!history && (
          <button className="link" onClick={() => setHistory(true)}>
            <Clock size={17} /> 资金记录 <ArrowRight size={15} />
          </button>
        )}
      </div>
      <div className="asset-tabs" role="group" aria-label="钱包资产币种">
        {["USDT", "USDC"].map((c) => (
          <button
            key={c}
            className={currency === c ? "active" : ""}
            aria-pressed={currency === c}
            onClick={() => setCurrency(c)}
          >
            <span className={"asset-symbol " + c.toLowerCase()}>
              {c === "USDT" ? "₮" : "$"}
            </span>
            {c}
          </button>
        ))}
      </div>
      {!history ? (
        <>
          <div className="wallet-focus-card">
            <div className="wallet-label">
              <span>可用余额 · {currency}</span>
              <Badge>演示资产</Badge>
            </div>
            <strong className="wallet-focus-amount">
              {money(balance?.available ?? "0")}
            </strong>
            <div className="wallet-reserved">
              <Lock size={16} />
              <span>订单冻结</span>
              <strong>
                {money(balance?.frozen ?? "0")} {currency}
              </strong>
            </div>
            <div className="wallet-primary-actions">
              <button
                className="button outline"
                disabled={locked}
                onClick={() => onTopup(currency)}
              >
                <Plus size={18} /> 模拟充值
              </button>
              <button
                className="button"
                disabled={locked}
                onClick={() => onExchange(currency)}
              >
                {resumeDraft ? "返回结汇草稿" : "去结汇"}
                <ArrowRight size={18} />
              </button>
            </div>
          </div>
          {resumeDraft && (
            <p className="draft-hint" role="status">
              草稿已保留，充值后返回将重新获取报价。
            </p>
          )}
          <p className="wallet-disclaimer">
            <Lock size={14} /> 无真实充值地址，请勿转入真实资金。
          </p>
        </>
      ) : (
        <div className="card wallet-history">
          <div className="tabs">
            <button
              className={historyType === "deposits" ? "active" : ""}
              onClick={() => setHistoryType("deposits")}
            >
              模拟充值 <em>{credits.length}</em>
            </button>
            <button
              className={historyType === "orders" ? "active" : ""}
              onClick={() => setHistoryType("orders")}
            >
              结汇资金 <em>{funded.length}</em>
            </button>
          </div>
          {historyType === "deposits" ? (
            credits.length ? (
              credits.map((d) => (
                <div className="fund-record" key={d.id}>
                  <div>
                    <strong>模拟充值</strong>
                    <small>{date(d.at)}</small>
                  </div>
                  <div>
                    <strong className="teal">
                      +{money(d.amount)} {d.currency}
                    </strong>
                    <small>模拟已入账</small>
                  </div>
                </div>
              ))
            ) : (
              <Empty title="暂无该币种充值记录">
                完成模拟充值后会显示在这里。
              </Empty>
            )
          ) : funded.length ? (
            funded.map((o) => (
              <button
                className="fund-record"
                key={o.id}
                onClick={() => onOrder(o.id)}
              >
                <div>
                  <strong>{o.orderNumber ?? o.clientOrderId}</strong>
                  <small>订单创建于 {date(o.createdAt)}</small>
                </div>
                <div>
                  <strong>
                    {money(o.quote.totalDeposit)} {o.quote.sourceCurrency}
                  </strong>
                  <small>
                    {o.walletFundingStatus === "consumed"
                      ? "已结算扣除"
                      : o.walletFundingStatus === "released"
                        ? "已解除冻结"
                        : "订单冻结中"}
                  </small>
                </div>
                <ArrowRight size={16} />
              </button>
            ))
          ) : (
            <Empty title="暂无钱包结汇记录">
              提交结汇后可在这里查看当前冻结或结算状态。
            </Empty>
          )}
          <p className="muted small">
            各币种独立记录。结汇资金显示订单当前状态，详细进度请打开订单。
          </p>
        </div>
      )}
    </section>
  );
}
