"use client";
import { useRef, useState } from "react";
import SelectField from "./SelectField";
import { money } from "./models";
import { moneyRequest } from "./money-api";
import { Modal } from "./ui";
import { recentWithdrawalAddresses } from "./experience-models";
export default function RefundDialog({
  currency: initialCurrency,
  available: initialAvailable,
  balances,
  movements = [],
  onClose,
}: {
  currency: string;
  available: string;
  balances?: { currency: string; available: string }[];
  movements?: any[];
  onClose: () => void;
}) {
  const [currency, setCurrency] = useState("USDT");
  const available =
    balances?.find((b) => b.currency === currency)?.available ??
    initialAvailable;
  const [amount, setAmount] = useState(""),
    [destination, setDestination] = useState(""),
    [reason, setReason] = useState("");
  const [review, setReview] = useState(false),
    [submitted, setSubmitted] = useState(false);
  const key = useRef(crypto.randomUUID()),
    inFlight = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const network = "usdttrc20";
  const networkLabel = "TRON · TRC20";
  const recent = recentWithdrawalAddresses(movements, currency);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (inFlight.current) return;
    if (!review) {
      setReview(true);
      setError("");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setSubmitted(true);
    setError("");
    try {
      await moneyRequest("wallet/refunds", {
        currency,
        network,
        amount,
        destination: destination.trim(),
        reason: reason.trim(),
        idempotencyKey: key.current,
      });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  return (
    <Modal
      title={review ? "确认提现" : "申请提现"}
      busy={busy}
      onClose={onClose}
    >
      {error && (
        <p role="alert" className="note danger">
          {error}
        </p>
      )}
      <form onSubmit={submit} className="money-form">
        {!review ? (
          <>
            {balances && (
              <label>
                提现币种
                <SelectField
                  value={currency}
                  onChange={(e) => {
                    setCurrency(e.target.value);
                    setDestination("");
                    setAmount("");
                  }}
                  disabled={busy}
                >
                  <option value="USDT">USDT</option>
                </SelectField>
              </label>
            )}
            <p>
              可用余额：{money(available)} {currency}
            </p>
            <label>
              提现金额
              <div className="amount-with-action">
                <input
                  name="amount"
                  required
                  autoFocus
                  inputMode="decimal"
                  pattern="[0-9]+(\.[0-9]{1,6})?"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <button
                  type="button"
                  className="button text"
                  onClick={() => setAmount(available)}
                >
                  全部
                </button>
              </div>
            </label>
            <label>
              收款网络<strong>{networkLabel}</strong>
            </label>
            {recent.length > 0 && (
              <label>
                最近使用的提现地址
                <SelectField
                  value=""
                  onChange={(e) => setDestination(e.target.value)}
                >
                  <option value="">选择已完成提现使用的地址</option>
                  {recent.map((a) => (
                    <option key={a} value={a}>
                      {a.slice(0, 10)}…{a.slice(-8)}
                    </option>
                  ))}
                </SelectField>
              </label>
            )}
            <label>
              收款钱包地址
              <input
                name="destination"
                required
                autoComplete="off"
                spellCheck={false}
                maxLength={100}
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder={
                  currency === "USDT"
                    ? "T 开头的 TRON 地址"
                    : "0x 开头的 Base 地址"
                }
              />
            </label>
            <label>
              提现说明（选填）
              <input
                name="reason"
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <button className="button">下一步，核对提现</button>
          </>
        ) : (
          <>
            <dl className="details">
              <div>
                <dt>提现金额</dt>
                <dd>
                  <strong>
                    {money(amount)} {currency}
                  </strong>
                </dd>
              </div>
              <div>
                <dt>收款网络</dt>
                <dd>{networkLabel}</dd>
              </div>
              <div>
                <dt>收款地址</dt>
                <dd className="money-address">{destination.trim()}</dd>
              </div>
              {reason.trim() && (
                <div>
                  <dt>说明</dt>
                  <dd>{reason}</dd>
                </div>
              )}
            </dl>
            <p>
              提交后金额将暂时冻结，平台审核后付款；审核前可在资金记录取消。
            </p>
            <label className="money-confirm">
              <input type="checkbox" required disabled={busy} />
              我已核对金额、网络与地址，确认是我控制的钱包
            </label>
            {submitted && error && (
              <p className="muted small">
                可重试同一申请，或关闭后查看资金记录核对结果。
              </p>
            )}
            <div className="actions">
              <button className="button" disabled={busy}>
                {busy ? "正在提交…" : "确认申请提现"}
              </button>
              {!submitted && (
                <button
                  type="button"
                  className="button outline"
                  onClick={() => setReview(false)}
                >
                  返回修改
                </button>
              )}
            </div>
          </>
        )}
      </form>
    </Modal>
  );
}
