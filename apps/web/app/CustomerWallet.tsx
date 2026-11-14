"use client";
import RefundDialog from "./RefundDialog";
import { moneyRequest, movementLabels } from "./money-api";
import FundingDialog, { fundingStatus } from "./FundingDialog";
import { useEffect, useState } from "react";
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
  fundsDisabled = false,
  realFunds = false,
  fundingPayments = [],
  moneyEnabled = false,
  moneyMovements = [],
  onRefresh,
  onTopup,
  onExchange,
  onOrder,
  withdrawalRequest = 0,
  historyRequest,
  onWithdrawalOpened,
}: {
  balances: WalletBalance[];
  deposits: WalletDeposit[];
  orders: Order[];
  customerId: string;
  locked: boolean;
  resumeDraft: boolean;
  initialCurrency: string;
  fundsDisabled?: boolean;
  realFunds?: boolean;
  fundingPayments?: any[];
  moneyEnabled?: boolean;
  moneyMovements?: any[];
  onRefresh?: () => void | Promise<void>;
  onTopup: (currency: string) => void;
  onExchange: (currency: string) => void;
  onOrder: (id: string) => void;
  historyRequest?: { id: number; type: string };
  withdrawalRequest?: number;
  onWithdrawalOpened?: () => void;
}) {
  const [refundOpen, setRefundOpen] = useState(false),
    [refundError, setRefundError] = useState(""),
    [cancelling, setCancelling] = useState("");
  async function cancelRefund(id: string) {
    setRefundError("");
    setCancelling(id);
    try {
      await moneyRequest("money-movements/" + id + "/decision", {
        action: "cancel",
        note: "客户取消提现申请",
      });
      await onRefresh?.();
    } catch (e) {
      setRefundError((e as Error).message);
    } finally {
      setCancelling("");
    }
  }
  useEffect(() => {
    if (withdrawalRequest > 0 && moneyEnabled) {
      setHistory(false);
      setRefundOpen(true);
      onWithdrawalOpened?.();
    }
  }, [withdrawalRequest, moneyEnabled, onWithdrawalOpened]);
  const [fundingOpen, setFundingOpen] = useState(false);
  const [activeFunding, setActiveFunding] = useState<any>(null);
  const [currency, setCurrency] = useState(initialCurrency);
  const [history, setHistory] = useState(false);
  const [historyType, setHistoryType] = useState("deposits");
  useEffect(() => {
    if (historyRequest?.id) {
      setHistory(true);
      setHistoryType(historyRequest.type);
    }
  }, [historyRequest?.id]);
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
      {refundOpen && (
        <RefundDialog
          balances={balances}
          movements={moneyMovements}
          currency={currency}
          available={balance?.available ?? "0"}
          onClose={() => {
            setRefundOpen(false);
            void onRefresh?.();
          }}
        />
      )}
      {fundingOpen && (
        <FundingDialog
          currency={currency}
          initialPayment={activeFunding}
          onCredited={onRefresh}
          onExchange={() => {
            setFundingOpen(false);
            onExchange(currency);
          }}
          onClose={() => {
            setFundingOpen(false);
            if (onRefresh) void onRefresh();
            else window.location.reload();
          }}
        />
      )}
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
      {refundError && <p role="alert">{refundError}</p>}
      {!history ? (
        <>
          <div className="wallet-focus-card">
            <div className="wallet-label">
              <span>可用余额 · {currency}</span>
              <span className="wallet-asset-label">{currency} ACCOUNT</span>
            </div>
            <strong className="wallet-focus-amount">
              {money(balance?.available ?? "0")}
            </strong>
            <div className="wallet-reserved">
              <Lock size={16} />
              <span>冻结余额</span>
              <strong>
                {money(balance?.frozen ?? "0")} {currency}
              </strong>
            </div>
            <img
              className="wallet-brand-symbol"
              src="/brand/flow-symbol-v2.webp"
              alt=""
              width={1280}
              height={1280}
            />
            <div className="wallet-primary-actions">
              <button
                className="button outline"
                disabled={locked || fundsDisabled}
                onClick={() =>
                  realFunds
                    ? (setActiveFunding(null), setFundingOpen(true))
                    : onTopup(currency)
                }
              >
                <Plus size={18} />{" "}
                {fundsDisabled
                  ? "充值尚未开放"
                  : realFunds
                    ? "充值"
                    : "模拟充值"}
              </button>
              {moneyEnabled && (
                <button
                  className="button outline"
                  disabled={locked}
                  onClick={() => setRefundOpen(true)}
                >
                  提现
                </button>
              )}
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
          <div className="wallet-route-strip">
            <div>
              <ArrowRight size={21} />
              <div>
                <strong>支持结汇币种</strong>
              </div>
            </div>
            <div className="wallet-route-currencies" aria-label="支持的法币">
              {["CNY", "USD", "EUR", "MXN", "BRL", "GBP"].map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
          </div>
        </>
      ) : (
        <div className="card wallet-history">
          <div className="tabs">
            <button
              className={historyType === "deposits" ? "active" : ""}
              onClick={() => setHistoryType("deposits")}
            >
              {realFunds ? "充值记录" : "模拟充值"}{" "}
              <em>{realFunds ? fundingPayments.length : credits.length}</em>
            </button>
            <button
              className={historyType === "orders" ? "active" : ""}
              onClick={() => setHistoryType("orders")}
            >
              结汇资金 <em>{funded.length}</em>
            </button>
            {moneyEnabled && (
              <button
                className={historyType === "refunds" ? "active" : ""}
                onClick={() => setHistoryType("refunds")}
              >
                提现
              </button>
            )}
          </div>
          {historyType === "refunds" ? (
            moneyMovements.filter(
              (r) => r.kind === "refund" && r.currency === currency,
            ).length ? (
              moneyMovements
                .filter((r) => r.kind === "refund" && r.currency === currency)
                .map((r) => (
                  <div className="refund-record" key={r.id}>
                    <header>
                      <strong>{movementLabels[r.status]}</strong>
                      <strong>
                        {money(r.amount)} {r.currency}
                      </strong>
                    </header>
                    <small>
                      {date(r.created_at)} ·{" "}
                      {r.network === "usdttrc20" ? "TRON · TRC20" : "Base"}
                    </small>
                    <small className="money-address">{r.destination}</small>
                    {r.rejection_reason && (
                      <p className="note danger">
                        未通过原因：{r.rejection_reason}
                      </p>
                    )}
                    {r.status === "approved" && (
                      <p className="muted small">审核已通过，正在安排付款。</p>
                    )}
                    {r.txid && (
                      <small className="money-address">交易：{r.txid}</small>
                    )}
                    {r.status === "requested" && (
                      <button
                        className="button text"
                        disabled={!!cancelling}
                        onClick={() => void cancelRefund(r.id)}
                      >
                        {cancelling === r.id ? "正在取消…" : "取消申请"}
                      </button>
                    )}
                  </div>
                ))
            ) : (
              <Empty title="暂无提现记录">提现申请将在这里显示进度。</Empty>
            )
          ) : historyType === "deposits" && realFunds ? (
            fundingPayments.filter((p) => p.currency === currency).length ? (
              fundingPayments
                .filter((p) => p.currency === currency)
                .map((p) => (
                  <button
                    className="fund-record"
                    key={p.id}
                    onClick={() => {
                      setActiveFunding(p);
                      setFundingOpen(true);
                    }}
                  >
                    <div>
                      <strong>{fundingStatus(p.status)}</strong>
                      <small>{date(p.created_at)}</small>
                    </div>
                    <div>
                      <strong>
                        {money(p.credited_amount ?? p.requested_amount)}{" "}
                        {p.currency}
                      </strong>
                      <small>{p.credited_amount ? "已入账" : "充值申请"}</small>
                      {p.pay_address && (
                        <small
                          style={{ maxWidth: 160, overflowWrap: "anywhere" }}
                        >
                          {p.pay_address}
                        </small>
                      )}
                    </div>
                  </button>
                ))
            ) : (
              <Empty title="暂无充值记录">充值记录将在这里显示。</Empty>
            )
          ) : historyType === "deposits" ? (
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
