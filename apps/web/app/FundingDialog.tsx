"use client";
import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import SelectField from "./SelectField";
const names: Record<string, string> = {
  creating: "正在创建",
  waiting: "等待付款",
  confirming: "链上确认中",
  confirmed: "正在处理",
  sending: "正在结算",
  credited: "已入账",
  finished: "结算完成",
  partially_paid: "金额待核对",
  review: "待核对",
  creation_unknown: "正在核对充值信息",
  failed: "未完成",
  expired: "已过期",
  refunded: "已退款",
};
export function fundingStatus(status: string) {
  return names[status] ?? "处理中";
}
async function request(path: string, body?: unknown) {
  const r = await fetch("/workspace/api/wallet/funding" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const v = await r.json();
  if (!r.ok) {
    const errors: Record<string, string> = {
      INVALID_AMOUNT: "请输入大于零的充值金额。",
      BELOW_DEPOSIT_MINIMUM: "金额低于该网络的最低充值额，请增加金额。",
      DEPOSIT_LIMIT_EXCEEDED: "金额超过当前单笔充值限额。",
      DAILY_DEPOSIT_LIMIT: "已达到今日充值限额。",
      CUSTOMER_NOT_APPROVED: "请先完成账户审核。",
      DEPOSITS_UNAVAILABLE: "充值尚未开放。",
      PAYMENT_PROVIDER_UNAVAILABLE: "充值服务暂不可用，请稍后查看充值记录。",
      IDEMPOTENCY_CONFLICT: "本次充值信息已更改，请关闭窗口后重新操作。",
    };
    throw Error(errors[v.error] ?? "请求未完成，请稍后查看充值记录。");
  }
  return v;
}
export default function FundingDialog({
  currency,
  onClose,
  initialPayment,
  onCredited,
  onExchange,
}: {
  currency: string;
  onClose: () => void;
  initialPayment?: any;
  onCredited?: () => void | Promise<void>;
  onExchange?: () => void;
}) {
  const [config, setConfig] = useState<any>(null),
    [network, setNetwork] = useState(""),
    [payment, setPayment] = useState<any>(initialPayment ?? null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID()),
    submitted = useRef(false);
  useEffect(() => {
    void request("")
      .then((c) => {
        setConfig(c);
        setNetwork(c.networks.find((n: any) => n.asset === currency)?.id ?? "");
      })
      .catch((e) => setError(e.message));
  }, [currency]);
  useEffect(() => {
    if (!payment?.id) return;
    const timer = setInterval(() => {
      void request("/payments")
        .then((v) => {
          const p = v.payments.find((p: any) => p.id === payment.id);
          if (p) setPayment(p);
        })
        .then(() => setError(""))
        .catch(() => setError("状态更新暂时中断，请稍后重试或查看资金记录。"));
    }, 10000);
    return () => clearInterval(timer);
  }, [payment?.id]);
  const creditedNotified = useRef("");
  const creditedCallback = useRef(onCredited);
  creditedCallback.current = onCredited;
  useEffect(() => {
    if (!payment?.credited_amount || creditedNotified.current === payment.id)
      return;
    creditedNotified.current = payment.id;
    void Promise.resolve(creditedCallback.current?.()).catch(() =>
      setError("已入账，余额暂未更新，请稍后刷新钱包。"),
    );
  }, [payment?.id, payment?.credited_amount]);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitted.current) return;
    setBusy(true);
    setError("");
    submitted.current = true;
    try {
      const v = await request("/payments", {
        currency,
        network,
        amount: String(new FormData(e.currentTarget).get("amount")),
        idempotencyKey: key.current,
      });
      setPayment(v);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const selected = config?.networks.find(
    (n: any) => n.id === (payment?.pay_currency ?? network),
  );
  const networkLabel =
    selected?.label ??
    (
      {
        usdttrc20: "TRON · TRC20",
        usdtbsc: "BNB Smart Chain · BEP20",
        usdterc20: "Ethereum · ERC20",
        usdc: "Ethereum · ERC20",
        usdcbase: "Base",
      } as Record<string, string>
    )[payment?.pay_currency ?? network] ??
    "网络信息待核对";
  const canPay =
    !!payment?.pay_address &&
    payment.status === "waiting" &&
    !!config?.enabled &&
    selected?.asset === currency &&
    !payment.credited_amount;
  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(payment.pay_address);
      setNotice("地址已复制。");
      setError("");
    } catch {
      setError("复制失败，请长按充值地址复制。");
    }
  }
  return (
    <div className="security-overlay">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="充值"
        className="security-panel"
      >
        <header>
          <h2>充值 {currency}</h2>
          <button className="button text" onClick={onClose}>
            关闭
          </button>
        </header>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {!payment && config?.enabled && (
          <form onSubmit={submit}>
            <label>
              充值网络
              <SelectField
                value={network}
                onChange={(e) => setNetwork(e.target.value)}
                disabled={busy || submitted.current}
              >
                {config.networks
                  .filter((n: any) => n.asset === currency)
                  .map((n: any) => (
                    <option value={n.id} key={n.id}>
                      {n.label}
                    </option>
                  ))}
              </SelectField>
            </label>
            <label>
              充值金额
              <input
                required
                name="amount"
                inputMode="decimal"
                pattern="[0-9]+(\.[0-9]{1,6})?"
                placeholder="输入充值金额"
                disabled={busy || submitted.current}
              />
            </label>
            <p>
              按实际结算净额入账，手续费可能从充值中扣除。
              {config.maxDeposit && (
                <>
                  单笔最高 {config.maxDeposit} {currency}。
                </>
              )}
            </p>
            <button
              className="button"
              disabled={busy || !network || submitted.current}
            >
              {busy ? "正在获取充值地址…" : "获取充值地址"}
            </button>
            {submitted.current && !busy && (
              <p>请关闭后在充值记录中核对本次结果，勿重复提交。</p>
            )}
          </form>
        )}
        {payment && (
          <>
            <p>
              <strong>{fundingStatus(payment.status)}</strong>
            </p>
            {!payment.credited_amount && payment.pay_address && (
              <>
                <div className="funding-payment-heading">
                  <strong>{currency}</strong>
                  <span className="funding-chain">{networkLabel}</span>
                </div>
                <p className="funding-pay-amount">
                  转入金额{" "}
                  <strong>
                    {payment.pay_amount} {currency}
                  </strong>
                </p>
                {canPay && (
                  <div className="funding-qr">
                    <QRCodeSVG
                      value={payment.pay_address}
                      size={216}
                      marginSize={4}
                      level="M"
                      title={`${currency} · ${networkLabel} 充值地址二维码`}
                      role="img"
                      aria-label="充值地址二维码"
                    />
                    <span>使用钱包扫码，核对币种与网络</span>
                  </div>
                )}
                <label>
                  充值地址
                  <code className="security-secret funding-address">
                    {payment.pay_address}
                  </code>
                </label>
                <button
                  className="button outline"
                  onClick={() => void copyAddress()}
                  disabled={!canPay}
                >
                  复制地址
                </button>
                {!canPay && (
                  <p className="muted small">
                    {payment.credited_amount
                      ? "本笔充值已入账，请勿再次转入。"
                      : ["confirming", "confirmed", "sending"].includes(
                            payment.status,
                          )
                        ? "已检测到付款，请等待入账，勿重复转账。"
                        : "当前记录不可继续付款，请查看充值状态。"}
                  </p>
                )}
                {payment.extra_id && (
                  <p>
                    Memo / Tag：<code>{payment.extra_id}</code>
                  </p>
                )}
                <p>
                  仅转入 {currency} · {networkLabel}
                  ，请勿使用其他网络。本地址仅用于本次充值，到账状态会自动更新。
                </p>
              </>
            )}
            {payment.credited_amount && (
              <div className="funding-success" role="status">
                <h3>充值已到账</h3>
                <p>
                  实际入账{" "}
                  <strong>
                    {payment.credited_amount} {currency}
                  </strong>
                </p>
                <div className="actions">
                  {onExchange && (
                    <button className="button" onClick={onExchange}>
                      去结汇
                    </button>
                  )}
                  <button className="button outline" onClick={onClose}>
                    返回钱包
                  </button>
                </div>
              </div>
            )}
          </>
        )}
        {config && !config.enabled && <p>充值尚未开放，请稍后再试。</p>}
      </section>
    </div>
  );
}
