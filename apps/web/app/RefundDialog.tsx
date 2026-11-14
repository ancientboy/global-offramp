"use client";
import { useRef, useState } from "react";
import { money } from "./models";
import { moneyRequest } from "./money-api";
export default function RefundDialog({
  currency,
  available,
  onClose,
}: {
  currency: string;
  available: string;
  onClose: () => void;
}) {
  const key = useRef(crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    try {
      await moneyRequest("wallet/refunds", {
        currency,
        network: currency === "USDT" ? "usdttrc20" : "usdcbase",
        amount: String(f.get("amount")),
        destination: String(f.get("destination")).trim(),
        reason: String(f.get("reason")).trim(),
        idempotencyKey: key.current,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="security-overlay">
      <section
        className="security-panel"
        role="dialog"
        aria-modal="true"
        aria-label="申请提现"
      >
        <header>
          <h2>申请提现</h2>
          <button className="button text" onClick={onClose} disabled={busy}>
            关闭
          </button>
        </header>
        {error && <p role="alert">{error}</p>}
        <form onSubmit={submit}>
          <p>
            可用余额：{money(available)} {currency}
          </p>
          <label>
            提现金额
            <input
              name="amount"
              required
              autoFocus
              inputMode="decimal"
              pattern="[0-9]+(\.[0-9]{1,6})?"
              disabled={busy}
            />
          </label>
          <label>
            收款网络
            <strong>
              {currency === "USDT" ? "TRON · TRC20" : "Base · USDC"}
            </strong>
          </label>
          <label>
            收款钱包地址
            <input
              name="destination"
              required
              autoComplete="off"
              spellCheck={false}
              maxLength={100}
              placeholder={
                currency === "USDT"
                  ? "填写 T 开头的 TRON 地址"
                  : "填写 0x 开头的 Base 地址"
              }
              disabled={busy}
            />
          </label>
          <label>
            提现说明
            <input
              name="reason"
              required
              minLength={3}
              maxLength={300}
              disabled={busy}
            />
          </label>
          <p>
            请填写你控制的同网络钱包地址。提交后金额将暂时冻结，审核通过后转入所填地址；审核前可取消。
          </p>
          <button className="button" disabled={busy}>
            {busy ? "正在提交…" : "提交申请"}
          </button>
        </form>
      </section>
    </div>
  );
}
