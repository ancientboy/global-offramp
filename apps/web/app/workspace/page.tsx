"use client";
import AccountSecurity, {
  securityMessages,
  securityRequest,
} from "../AccountSecurity";
import SelectField from "../SelectField";
import dynamic from "next/dynamic";
import { FormEvent, useEffect, useState } from "react";
const Home = dynamic(() => import("../page"), {
  ssr: false,
  loading: () => <p className="auth-loading">正在加载工作台…</p>,
});
const ProviderPortal = dynamic(() => import("../ProviderPortal"), {
  ssr: false,
});
const PartnerPortal = dynamic(() => import("../PartnerPortal"), { ssr: false });
import Brand from "../Brand";
import {
  ArrowRight,
  Eye,
  EyeSlash,
  LockKey,
  UserCircle,
} from "@phosphor-icons/react";
import { WorkspaceContext, type WorkspaceAccount } from "../workspace-context";

const errors: Record<string, string> = {
  ...securityMessages,
  INVITE_UNAVAILABLE: "邀请链接不可用，请联系邀请人获取新链接。",
  PARTNER_UNAVAILABLE: "伙伴账号已停用，请联系管理员。",
  EMAIL_IN_USE: "该邮箱已注册，请登录。",
  INVALID_INPUT: "请检查账号格式和密码（12–128个字符）。",
  INVALID_CREDENTIALS: "账号或密码不正确。",
  RATE_LIMITED: "请求较多，请稍后再试。",
  AUTH_BUSY: "登录繁忙，请稍后再试。",
  CSRF_REJECTED: "请求来源校验失败，请从本站重新打开。",
};
async function authRequest(path: string, body?: unknown) {
  const r = await fetch("/workspace/api/auth/" + path, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await r.json();
  if (!r.ok)
    throw new Error(
      errors[result.error] ?? "会话不可用或请求失败，请重新登录。",
    );
  return result;
}
export default function Workspace() {
  const [securityOpen, setSecurityOpen] = useState(false);
  const [securityStatus, setSecurityStatus] = useState<any>(null);
  const [otpRequired, setOtpRequired] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [account, setAccount] = useState<WorkspaceAccount | null>(null);
  const [loading, setLoading] = useState(true),
    [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [inviteCode, setInviteCode] = useState(""),
    [inviter, setInviter] = useState(""),
    [inviteValid, setInviteValid] = useState(false),
    [inviteLoading, setInviteLoading] = useState(false);
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("invite");
    if (code) {
      setRegister(true);
      setInviteCode(code);
      setInviteLoading(true);
      fetch("/workspace/api/invites/" + encodeURIComponent(code), {
        credentials: "same-origin",
        cache: "no-store",
      })
        .then(async (r) => {
          if (!r.ok) throw Error(errors.INVITE_UNAVAILABLE);
          const value = await r.json();
          setInviter(value.partnerName);
          setInviteValid(true);
        })
        .catch((e) => setError(e.message))
        .finally(() => setInviteLoading(false));
    }

    void authRequest("me")
      .then((v) => setAccount(v.account))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  async function refreshSecurity() {
    try {
      const next = await securityRequest("");
      setSecurityStatus(next);
      if (
        next.enforced &&
        (!next.passwordChanged || (next.privileged && !next.mfaEnabled))
      )
        setSecurityOpen(true);
      return next;
    } catch {
      setSecurityStatus(null);
    }
  }
  useEffect(() => {
    if (account) void refreshSecurity();
  }, [account?.id]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const formElement = e.currentTarget;
    const form = new FormData(formElement);
    const identifier = String(form.get("identifier")),
      password = String(form.get("password"));
    try {
      if (register) {
        if (inviteCode && !inviteValid) throw Error(errors.INVITE_UNAVAILABLE);
        await authRequest("register", {
          email: identifier,
          password,
          name: String(form.get("name")),
          kind: String(form.get("kind")),
          ...(inviteCode ? { inviteCode } : {}),
        });
        setRegister(false);
        setInviteCode("");
        setInviter("");
        setInviteValid(false);
        window.history.replaceState({}, "", window.location.pathname);
        setNotice("账号已创建，请登录。客户审核待管理员处理。");
        formElement.reset();
      } else {
        const code = String(form.get("code") ?? "").trim();
        const result = await authRequest("login", {
          identifier,
          password,
          ...(code ? { code } : {}),
        });
        setAccount(result.account);
      }
    } catch (e) {
      if (e instanceof Error && e.message === securityMessages.MFA_REQUIRED)
        setOtpRequired(true);
      setError(e instanceof Error ? e.message : "请求失败");
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <main className="auth-loading">
        <Brand />
        <p>正在核对账号会话…</p>
      </main>
    );
  if (account)
    return (
      <WorkspaceContext.Provider
        value={{
          account,
          expired: () => setAccount(null),
          logout: async () => {
            await authRequest("logout", {});
            setAccount(null);
          },
        }}
      >
        <button
          className="security-launch"
          onClick={() => setSecurityOpen(true)}
        >
          账户安全
        </button>
        {(securityOpen ||
          (securityStatus?.enforced &&
            (!securityStatus.passwordChanged ||
              (securityStatus.privileged && !securityStatus.mfaEnabled)))) && (
          <AccountSecurity
            mandatory={
              !!securityStatus?.enforced &&
              (!securityStatus.passwordChanged ||
                (securityStatus.privileged && !securityStatus.mfaEnabled))
            }
            onClose={() => {
              setSecurityOpen(false);
              if (securityStatus?.enforced) window.location.reload();
            }}
            onReady={() => void refreshSecurity()}
          />
        )}
        {account.role === "partner" ? (
          <PartnerPortal />
        ) : account.role === "payout_provider" ? (
          <ProviderPortal />
        ) : (
          <Home key={account.id} />
        )}
      </WorkspaceContext.Provider>
    );
  return (
    <main className="auth-shell">
      <aside className="auth-story" aria-label="汇途品牌介绍">
        <a href="/" className="auth-brand-link" aria-label="汇途首页">
          <Brand dark />
        </a>
        <div className="auth-story-copy">
          <span className="auth-eyebrow">
            GLOBAL PAYMENTS. CLEARER CONNECTIONS.
          </span>
          <h2>
            让每一笔，
            <br />
            <em>清晰抵达。</em>
          </h2>
          <p>
            从稳定币到本地结算，
            <br />
            连接更广阔的生意。
          </p>
        </div>
        <img
          className="auth-sculpture"
          src="/brand/flow-sculpture-v2.webp"
          alt=""
          width={1448}
          height={1086}
          loading="lazy"
        />
        <div className="auth-story-foot">
          <div className="auth-currencies" aria-label="支持的法币">
            {["CNY", "USD", "EUR", "MXN", "BRL", "GBP"].map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <span>USDT / USDC · 多币种结算</span>
        </div>
      </aside>
      <section className="auth-form-panel">
        <div className="auth-mobile-brand">
          <Brand />
        </div>
        <div className="auth-form-card">
          <span className="auth-overline">
            {register ? "START YOUR GLOBAL JOURNEY" : "YOUR GLOBAL WORKSPACE"}
          </span>
          <h1>{register ? "注册账号" : "欢迎回到汇途"}</h1>
          <p className="auth-intro">
            {register
              ? "一个账户，开启你的全球业务。"
              : "登录账户，继续你的全球业务。"}
          </p>
          {register && inviteCode && (
            <div className="invited-registration">
              {inviteLoading
                ? "正在核对邀请链接…"
                : inviteValid
                  ? "由 " + inviter + " 邀请注册，成功后将自动建立客户归属。"
                  : "邀请链接不可用，请联系邀请人。"}
            </div>
          )}
          <form className="auth-form" onSubmit={(e) => void submit(e)}>
            {register && (
              <>
                <label>
                  姓名或企业名称
                  <input
                    name="name"
                    required
                    maxLength={100}
                    autoComplete="name"
                  />
                </label>
                <label>
                  客户类型
                  <SelectField name="kind">
                    <option value="personal">个人</option>
                    <option value="company">企业</option>
                  </SelectField>
                </label>
              </>
            )}
            <label>
              {register ? "邮箱" : "用户名 / 邮箱"}
              <div className="auth-input">
                <UserCircle size={19} aria-hidden="true" />
                <input
                  name="identifier"
                  type={register ? "email" : "text"}
                  required
                  maxLength={254}
                  autoComplete="username"
                  placeholder={
                    register ? "请输入邮箱地址" : "请输入用户名或邮箱"
                  }
                />
              </div>
            </label>
            <label>
              密码
              <div className="auth-input">
                <LockKey size={18} aria-hidden="true" />
                <input
                  name="password"
                  type={passwordVisible ? "text" : "password"}
                  required
                  minLength={register ? 12 : 1}
                  maxLength={128}
                  autoComplete={register ? "new-password" : "current-password"}
                  placeholder={register ? "设置至少 12 位密码" : "请输入密码"}
                />
                <button
                  className="auth-reveal"
                  type="button"
                  aria-label={passwordVisible ? "隐藏密码" : "显示密码"}
                  onClick={() => setPasswordVisible(!passwordVisible)}
                >
                  {passwordVisible ? <EyeSlash size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </label>
            {error && <p role="alert">{error}</p>}
            {notice && <p role="status">{notice}</p>}
            {!register && otpRequired && (
              <label>
                验证器动态码 / 恢复码
                <input
                  name="code"
                  required
                  autoComplete="one-time-code"
                  maxLength={40}
                  minLength={6}
                />
              </label>
            )}
            <button
              className="button"
              disabled={
                busy ||
                (register && !!inviteCode && (!inviteValid || inviteLoading))
              }
              type="submit"
            >
              {busy ? "处理中…" : register ? "创建客户账号" : "登录"}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
            <button
              className="button text"
              disabled={busy}
              type="button"
              onClick={() => {
                setRegister(!register);
                setError("");
                setNotice("");
              }}
            >
              {register ? "已有账号，去登录" : "注册个人 / 企业账号"}
            </button>
          </form>
        </div>
        <footer className="auth-footer">
          <span>HUITU · 连接全球价值</span>
          <a href="/">返回首页</a>
        </footer>
      </section>
    </main>
  );
}
