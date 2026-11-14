"use client";
import { useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { USDT_TRC20_RECEIVER } from "../../../packages/core/src/deposit-policy";
const names: Record<string, string> = {
  creating: "正在创建",
  waiting: "等待付款",
  confirming: "链上确认中",
  confirmed: "正在处理",
  sending: "正在结算",
  credited: "已入账",
  finished: "已完成",
  partially_paid: "金额待核对",
  review: "待核对",
  creation_unknown: "正在核对",
  failed: "未完成",
  expired: "已过期",
  refunded: "已退款",
};
export function fundingStatus(s: string) {
  return names[s] ?? "处理中";
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
  if (!r.ok)
    throw Error(
      (
        {
          INVALID_AMOUNT: "请输入大于零的金额，最多两位小数。",
          CHAIN_MONITOR_UNAVAILABLE: "链上确认服务正在恢复，请稍后创建充值。",
          DEPOSIT_AMOUNT_BUSY: "该金额暂不可用，请调整金额后重试。",
          CUSTOMER_NOT_APPROVED: "请先完成账户审核。",
          DEPOSITS_UNAVAILABLE: "充值暂不可用。",
          IDEMPOTENCY_CONFLICT: "本次充值信息已更改，请重新创建。",
        } as Record<string, string>
      )[v.error] ?? "请求未完成，请先查看充值记录，勿重复提交。",
    );
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
    [payment, setPayment] = useState<any>(initialPayment ?? null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [now, setNow] = useState(Date.now()),
    [ack, setAck] = useState(false);
  const key = useRef(crypto.randomUUID()),
    submitted = useRef(false),
    notified = useRef("");
  const callback = useRef(onCredited);
  callback.current = onCredited;
  useEffect(() => {
    void request("")
      .then(setConfig)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!payment?.id) return;
    const t = setInterval(() => {
      void request("/payments")
        .then((v) => {
          const p = v.payments.find((p: any) => p.id === payment.id);
          if (p) setPayment(p);
        })
        .catch(() => setError("状态更新暂时中断，请稍后查看资金记录。"));
    }, 10000);
    return () => clearInterval(t);
  }, [payment?.id]);
  useEffect(() => {
    if (!payment?.credited_amount || notified.current === payment.id) return;
    notified.current = payment.id;
    void Promise.resolve(callback.current?.()).catch(() =>
      setError("充值已入账，请稍后刷新余额。"),
    );
  }, [payment?.id, payment?.credited_amount]);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitted.current) return;
    submitted.current = true;
    setBusy(true);
    setError("");
    try {
      setPayment(
        await request("/payments", {
          currency: "USDT",
          network: "usdttrc20",
          amount: String(new FormData(e.currentTarget).get("amount")),
          idempotencyKey: key.current,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const trusted =
    config?.receiver === USDT_TRC20_RECEIVER &&
    (!payment ||
      (payment.source === "direct_tron" &&
        payment.pay_address === USDT_TRC20_RECEIVER &&
        payment.pay_currency === "usdttrc20" &&
        payment.currency === "USDT"));
  const expires = Date.parse(payment?.expires_at ?? ""),
    left = Math.min(1800, Math.max(0, Math.ceil((expires - now) / 1000)));
  const canPay =
    trusted &&
    config?.enabled &&
    payment?.status === "waiting" &&
    !payment.credited_amount &&
    left > 0 &&
    /^\d+\.\d{6}$/.test(payment.pay_amount);
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(label + "已复制");
    } catch {
      setError("复制失败，请长按复制。");
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
          <h2>充值 USDT</h2>
          <button className="button text" onClick={onClose}>
            关闭
          </button>
        </header>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {config && !trusted && (
          <p className="note danger" role="alert">
            充值地址校验未通过，已停止展示付款信息。请联系平台核对，勿转账。
          </p>
        )}
        {!payment && config?.enabled && trusted && (
          <form onSubmit={submit}>
            <p className="funding-chain">TRON · TRC20</p>
            <label>
              充值金额
              <input
                required
                name="amount"
                inputMode="decimal"
                pattern="(0|[1-9][0-9]*)(\.[0-9]{1,2})?"
                placeholder="输入金额"
                disabled={busy || submitted.current}
              />
            </label>
            <p>
              系统将生成带小数尾数的付款金额，请按完整金额转账。实际收到多少，入账多少；转出钱包的手续费另付。
            </p>
            <button
              className="button full"
              disabled={busy || submitted.current}
            >
              {busy ? "正在生成…" : "获取充值金额与地址"}
            </button>
            {submitted.current && !busy && (
              <p>请先查看充值记录，勿重复提交。</p>
            )}
          </form>
        )}
        {payment && (
          <>
            <p>
              <strong>
                {fundingStatus(
                  payment.status === "waiting" &&
                    left === 0 &&
                    payment.source === "direct_tron"
                    ? "expired"
                    : payment.status,
                )}
              </strong>
            </p>
            {canPay && (
              <>
                <div className="funding-payment-heading">
                  <strong>USDT</strong>
                  <span className="funding-chain">TRON · TRC20</span>
                </div>
                <div className="deposit-cost-summary">
                  <p>请准确转入</p>
                  <p className="funding-pay-amount">
                    <strong>{payment.pay_amount} USDT</strong>
                  </p>
                  <button
                    className="button outline"
                    onClick={() => void copy(payment.pay_amount, "完整金额")}
                  >
                    复制完整金额
                  </button>
                  <p>
                    请保留全部 6
                    位小数，尾数也计入余额。少付、多付或分笔支付需要人工核对。
                  </p>
                  <small>
                    剩余 {Math.floor(left / 60)} 分 {left % 60} 秒
                  </small>
                </div>
                {!ack ? (
                  <button className="button full" onClick={() => setAck(true)}>
                    我会按完整金额转账，显示地址
                  </button>
                ) : (
                  <>
                    <div className="funding-qr">
                      <QRCodeSVG
                        value={USDT_TRC20_RECEIVER}
                        size={216}
                        marginSize={4}
                        level="M"
                        title="USDT · TRON TRC20 充值地址"
                        role="img"
                        aria-label="充值地址二维码"
                      />
                      <span>扫码后请填写上方完整金额</span>
                    </div>
                    <label>
                      固定充值地址
                      <code className="security-secret funding-address">
                        {USDT_TRC20_RECEIVER}
                      </code>
                    </label>
                    <p className="muted small">地址校验：TKcBJk ··· D6tnA</p>
                    <button
                      className="button outline"
                      onClick={() => void copy(USDT_TRC20_RECEIVER, "地址")}
                    >
                      复制地址
                    </button>
                  </>
                )}
                <p>
                  仅支持
                  USDT-TRC20。每次充值请创建新订单，勿重复使用旧金额。链上确认后自动到账。
                </p>
              </>
            )}
            {!canPay && !payment.credited_amount && (
              <p>
                {payment.source !== "direct_tron"
                  ? "该记录已停止收款，请创建新的充值订单。"
                  : left === 0
                    ? "本次付款金额已过期，请勿继续转入。已付款请等待链上核对，切勿重复支付。"
                    : "正在核对付款，请勿重复转账。"}
              </p>
            )}
            {payment.credited_amount && (
              <div className="funding-success" role="status">
                <h3>充值已到账</h3>
                <p>
                  实际入账{" "}
                  <strong>
                    {payment.credited_amount} {payment.currency ?? currency}
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
        {config && !config.enabled && <p>充值暂不可用，请稍后再试。</p>}
      </section>
    </div>
  );
}
