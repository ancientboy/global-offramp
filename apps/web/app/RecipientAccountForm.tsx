"use client";
import { useState, type FormEvent } from "react";
import SelectField from "./SelectField";
import { Modal } from "./ui";
import {
  ACCOUNT_METHODS,
  METHOD_NAMES,
  OPTION_NAMES,
  accountFields,
  validateFullRecipient,
} from "../../../packages/core/src/recipient-account";
import {
  EURO_AREA_COUNTRIES,
  type RecipientMethodId,
} from "../../../packages/core/src/route-catalog";
const regions: Record<string, string> = {
  CNY: "中国大陆",
  USD: "美国",
  EUR: "欧元区",
  MXN: "墨西哥",
  BRL: "巴西",
  GBP: "英国",
};
const countries: Record<string, string> = {
  CNY: "CN",
  USD: "US",
  EUR: "DE",
  MXN: "MX",
  BRL: "BR",
  GBP: "GB",
};
export default function RecipientAccountForm({
  initialCurrency,
  holder,
  onClose,
  onSaved,
  customerId,
  customers,
}: {
  initialCurrency: string;
  holder?: string;
  customerId?: string;
  customers?: { id: string; name: string }[];
  onClose: () => void;
  onSaved: (id: string, currency: string) => Promise<void>;
}) {
  const [ownerId, setOwnerId] = useState(customerId ?? "");
  const [currency, setCurrency] = useState(initialCurrency),
    [country, setCountry] = useState(countries[initialCurrency]),
    [method, setMethod] = useState<RecipientMethodId>(
      ACCOUNT_METHODS[initialCurrency][0],
    );
  const [values, setValues] = useState<Record<string, string>>({
      accountHolderName: holder ?? "",
    }),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const descriptors = accountFields(method);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (customers && !ownerId) {
      setError("请选择所属客户。");
      return;
    }
    const fields = Object.fromEntries(
      descriptors.map((f) => [f.id, values[f.id] ?? ""]),
    );
    const input = { country, currency, method, fields };
    const validation = validateFullRecipient(input);
    setErrors(validation.errors);
    if (!validation.valid) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/workspace/api/beneficiaries", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...input,
          fields: validation.fields,
          ...(customers ? { customerId: ownerId } : {}),
        }),
      });
      const result = await r.json();
      if (!r.ok) {
        if (result.fields) setErrors(result.fields);
        throw Error(
          result.error === "RECIPIENT_UNAVAILABLE"
            ? "账户保存暂不可用，请稍后重试。"
            : result.error === "CUSTOMER_BLOCKED"
              ? "账户尚未通过审核或已停用，请联系平台客服。"
              : result.error === "FORBIDDEN"
                ? "当前账户无法保存收款信息。"
                : "保存未完成，请检查收款信息。",
        );
      }
      await onSaved(result.id, currency);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="绑定收款账户" busy={busy} onClose={onClose}>
      <form onSubmit={save} className="recipient-account-form">
        {customers && (
          <label>
            所属客户
            <SelectField
              aria-label="所属客户"
              value={ownerId}
              disabled={busy}
              onChange={(e) => setOwnerId(e.target.value)}
            >
              <option value="">请选择客户</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </SelectField>
          </label>
        )}
        <div className="recipient-form-grid">
          <label>
            收款地区 / 币种
            <SelectField
              aria-label="收款地区 / 币种"
              value={currency}
              disabled={busy}
              onChange={(e) => {
                const c = e.target.value;
                setCurrency(c);
                setCountry(countries[c]);
                setMethod(ACCOUNT_METHODS[c][0]);
                setValues({
                  accountHolderName: values.accountHolderName ?? "",
                });
                setErrors({});
              }}
            >
              {Object.keys(regions).map((c) => (
                <option key={c} value={c}>
                  {regions[c]} · {c}
                </option>
              ))}
            </SelectField>
          </label>
          {currency === "EUR" && (
            <label>
              银行所在国家
              <SelectField
                aria-label="银行所在国家"
                value={country}
                disabled={busy}
                onChange={(e) => {
                  setCountry(e.target.value);
                  setErrors({});
                }}
              >
                {EURO_AREA_COUNTRIES.map((c) => (
                  <option key={c} value={c}>
                    {new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(c)}
                  </option>
                ))}
              </SelectField>
            </label>
          )}
          {ACCOUNT_METHODS[currency].length > 1 && (
            <label>
              收款方式
              <SelectField
                aria-label="收款方式"
                value={method}
                disabled={busy}
                onChange={(e) => {
                  setMethod(e.target.value as RecipientMethodId);
                  setValues({
                    accountHolderName: values.accountHolderName ?? "",
                  });
                  setErrors({});
                }}
              >
                {ACCOUNT_METHODS[currency].map((m) => (
                  <option key={m} value={m}>
                    {METHOD_NAMES[m]}
                  </option>
                ))}
              </SelectField>
            </label>
          )}
        </div>
        <div className="recipient-form-grid">
          {descriptors.map((f) => (
            <label key={method + f.id}>
              {f.label}
              {f.required ? " *" : ""}
              {f.options ? (
                <SelectField
                  aria-label={f.label}
                  value={values[f.id] ?? ""}
                  disabled={busy}
                  onChange={(e) => {
                    setValues({
                      ...values,
                      [f.id]: e.target.value,
                      ...(f.id === "pixKeyType" ? { pixKey: "" } : {}),
                    });
                    setErrors({ ...errors, [f.id]: "" });
                  }}
                >
                  <option value="">请选择</option>
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {OPTION_NAMES[o] ?? o}
                    </option>
                  ))}
                </SelectField>
              ) : (
                <input
                  aria-label={f.label}
                  aria-invalid={!!errors[f.id]}
                  aria-describedby={
                    errors[f.id] ? "recipient-" + f.id : undefined
                  }
                  type={f.inputMode === "email" ? "email" : "text"}
                  inputMode={f.inputMode ?? "text"}
                  placeholder={f.placeholder}
                  value={values[f.id] ?? ""}
                  required={f.required}
                  maxLength={200}
                  disabled={busy}
                  autoComplete="off"
                  onChange={(e) => {
                    setValues({ ...values, [f.id]: e.target.value });
                    setErrors({ ...errors, [f.id]: "" });
                  }}
                />
              )}
              {errors[f.id] && (
                <small
                  id={"recipient-" + f.id}
                  className="recipient-field-error"
                  role="alert"
                >
                  {errors[f.id]}
                </small>
              )}
            </label>
          ))}
        </div>
        {(errors.country || errors.form || errors.method) && (
          <p role="alert">{errors.country ?? errors.form ?? errors.method}</p>
        )}
        {error && <p role="alert">{error}</p>}
        <p className="muted small">请按银行留存的信息填写。</p>
        <button className="button full" type="submit" disabled={busy}>
          {busy ? "正在保存…" : "绑定收款账户"}
        </button>
      </form>
    </Modal>
  );
}
