"use client";
import { useEffect, useState } from "react";
export const securityMessages: Record<string, string> = {
  MFA_REQUIRED: "请输入验证器动态码或恢复码。",
  INVALID_OTP: "验证码不正确、已使用或已过期，请使用新验证码。",
  MFA_SETUP_REQUIRED: "请先开启二次验证。",
  MFA_STEP_UP_REQUIRED: "请打开账户安全，验证动态码后重试。",
  PASSWORD_CHANGE_REQUIRED: "请先设置正式使用的密码。",
  WEAK_PASSWORD: "请使用至少 12 位、不同于测试密码的新密码。",
  INVALID_CREDENTIALS: "当前密码不正确。",
  RATE_LIMITED: "尝试较多，请稍后再试。",
  MFA_ALREADY_ENABLED: "已开启二次验证。",
};
export async function securityRequest(path: string, body?: unknown) {
  const r = await fetch("/workspace/api/auth/security" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await r.json();
  if (!r.ok)
    throw Error(securityMessages[value.error] ?? "操作失败，请稍后重试。");
  return value;
}
export default function AccountSecurity({
  onClose,
  onReady,
  mandatory = false,
}: {
  onClose: () => void;
  onReady: () => void;
  mandatory?: boolean;
}) {
  const [status, setStatus] = useState<any>(null),
    [secret, setSecret] = useState(""),
    [codes, setCodes] = useState<string[]>([]),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  async function refresh() {
    setStatus(await securityRequest(""));
  }
  useEffect(() => {
    void refresh().catch((e) => setNotice(e.message));
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>, path: string) {
    e.preventDefault();
    setBusy(true);
    setNotice("");
    const form = e.currentTarget;
    try {
      const r = await securityRequest(
        path,
        Object.fromEntries(new FormData(form)),
      );
      if (r.secret) setSecret(r.secret);
      if (r.recoveryCodes) {
        setCodes(r.recoveryCodes);
        setSecret("");
      }
      setNotice("已保存。");
      form.reset();
      await refresh();
      if (!r.recoveryCodes) onReady();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="security-overlay">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="账户安全"
        className="security-panel"
      >
        <header>
          <h2>账户安全</h2>
          {!mandatory && (
            <button
              className="button text"
              onClick={onClose}
              aria-label="关闭账户安全"
            >
              关闭
            </button>
          )}
        </header>
        {mandatory && <p>完成账户安全设置后即可继续。</p>}
        {notice && <p role="status">{notice}</p>}
        <form onSubmit={(e) => submit(e, "/password")}>
          <h3>修改密码</h3>
          <label>
            当前密码
            <input
              required
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              maxLength={128}
            />
          </label>
          <label>
            新密码
            <input
              required
              type="password"
              name="password"
              autoComplete="new-password"
              minLength={12}
              maxLength={128}
              placeholder="至少 12 个字符"
            />
          </label>
          <button className="button" disabled={busy}>
            保存新密码
          </button>
        </form>
        {status && !status.mfaEnabled && !secret && (
          <form onSubmit={(e) => submit(e, "/setup")}>
            <h3>二次验证</h3>
            <p>使用验证器生成动态码，保护登录和资金操作。</p>
            <label>
              确认当前密码
              <input
                required
                type="password"
                name="password"
                autoComplete="current-password"
                maxLength={128}
              />
            </label>
            <button className="button outline" disabled={busy}>
              设置验证器
            </button>
          </form>
        )}
        {secret && (
          <form onSubmit={(e) => submit(e, "/confirm")}>
            <h3>绑定验证器</h3>
            <p>
              在验证器中添加账户，选择手动输入密钥，使用基于时间的 6 位动态码。
            </p>
            <code className="security-secret">{secret}</code>
            <button
              className="button text"
              type="button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(secret)
                  .then(() => setNotice("密钥已复制。"))
              }
            >
              复制设置密钥
            </button>
            <label>
              验证器动态码
              <input
                required
                name="code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                autoComplete="one-time-code"
                maxLength={6}
              />
            </label>
            <button className="button" disabled={busy}>
              确认开启
            </button>
          </form>
        )}
        {status?.mfaEnabled && (
          <form onSubmit={(e) => submit(e, "/verify")}>
            <h3>二次验证已开启</h3>
            <label>
              动态码或恢复码
              <input
                required
                name="code"
                autoComplete="one-time-code"
                minLength={6}
                maxLength={40}
              />
            </label>
            <button className="button outline" disabled={busy}>
              验证资金操作
            </button>
          </form>
        )}
        {codes.length > 0 && (
          <div role="status">
            <h3>请保存恢复码</h3>
            <p>
              验证器不可用时可用于登录，每个恢复码只能使用一次。关闭后不再显示。
            </p>
            <pre className="security-secret">{codes.join("\n")}</pre>
            <button
              className="button outline"
              onClick={() =>
                void navigator.clipboard
                  .writeText(codes.join("\n"))
                  .then(() => setNotice("恢复码已复制。"))
              }
            >
              复制恢复码
            </button>
          </div>
        )}
        {mandatory &&
          status?.passwordChanged &&
          (!status.privileged || status.mfaEnabled) && (
            <button
              className="button"
              onClick={() => {
                onReady();
                onClose();
              }}
            >
              进入工作台
            </button>
          )}
      </section>
    </div>
  );
}
