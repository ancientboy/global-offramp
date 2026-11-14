"use client";
import { useEffect, useRef, useState } from "react";
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
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const v = await r.json();
  if (!r.ok) {
    const errors: Record<string, string> = {
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
}: {
  currency: string;
  onClose: () => void;
  initialPayment?: any;
}) {
  const [config, setConfig] = useState<any>(null),
    [network, setNetwork] = useState(""),
    [payment, setPayment] = useState<any>(initialPayment ?? null),
    [error, setError] = useState(""),
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
        .catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [payment?.id]);
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
              按实际结算净额入账，手续费可能从充值中扣除。单笔最高{" "}
              {config.maxDeposit} {currency}。
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
            {payment.pay_address && (
              <>
                <p>网络：{selected?.label ?? payment.pay_currency}</p>
                <p>
                  转入金额：
                  <strong>
                    {payment.pay_amount} {currency}
                  </strong>
                </p>
                <label>
                  充值地址
                  <code className="security-secret">{payment.pay_address}</code>
                </label>
                <button
                  className="button outline"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(payment.pay_address)
                      .then(() => setError("地址已复制。"))
                  }
                >
                  复制地址
                </button>
                {payment.extra_id && (
                  <p>
                    Memo / Tag：<code>{payment.extra_id}</code>
                  </p>
                )}
                <p>
                  仅向本地址转入指定网络的 {currency}
                  ，本地址仅用于本次充值。到账状态将自动更新。
                </p>
              </>
            )}
            {payment.credited_amount && (
              <p>
                已入账 {payment.credited_amount} {currency}
              </p>
            )}
          </>
        )}
        {config && !config.enabled && <p>充值尚未开放，请稍后再试。</p>}
      </section>
    </div>
  );
}
