"use client";
import SelectField from "../SelectField";
import { FormEvent, useEffect, useState } from "react";
import Home from "../page";
import { WorkspaceContext, type WorkspaceAccount } from "../workspace-context";

const errors: Record<string, string> = {
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
  const [account, setAccount] = useState<WorkspaceAccount | null>(null);
  const [loading, setLoading] = useState(true),
    [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  useEffect(() => {
    void authRequest("me")
      .then((v) => setAccount(v.account))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
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
        await authRequest("register", {
          email: identifier,
          password,
          name: String(form.get("name")),
          kind: String(form.get("kind")),
        });
        setRegister(false);
        setNotice("账号已创建，请登录。客户审核待管理员处理。");
        formElement.reset();
      } else {
        const result = await authRequest("login", { identifier, password });
        setAccount(result.account);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败");
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <main className="card" style={{ maxWidth: 480, margin: "10vh auto" }}>
        正在核对账号会话…
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
        <Home key={account.id} />
      </WorkspaceContext.Provider>
    );
  return (
    <main
      className="card"
      style={{ maxWidth: 480, margin: "8vh auto", padding: 32 }}
    >
      <h1>汇途 · {register ? "注册账号" : "业务登录"}</h1>
      <p>登录后管理钱包、订单和收款账户。</p>
      <form onSubmit={(e) => void submit(e)}>
        {register && (
          <>
            <label>
              姓名或企业名称
              <input name="name" required maxLength={100} autoComplete="name" />
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
          <input
            name="identifier"
            type={register ? "email" : "text"}
            required
            maxLength={254}
            autoComplete="username"
          />
        </label>
        <label>
          密码
          <input
            name="password"
            type="password"
            required
            minLength={register ? 12 : 1}
            maxLength={128}
            autoComplete={register ? "new-password" : "current-password"}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <button className="button" disabled={busy} type="submit">
          {busy ? "处理中…" : register ? "创建客户账号" : "登录"}
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
      <p>
        <a href="/">返回首页</a>
      </p>
    </main>
  );
}
