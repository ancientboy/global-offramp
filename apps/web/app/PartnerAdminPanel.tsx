"use client";
import { useEffect, useState } from "react";
import { Badge, Modal } from "./ui";
import { date } from "./models";
type Partner = {
  id: string;
  name: string;
  username: string;
  status: "active" | "disabled";
  inviteUrl: string;
  customerCount: number;
  createdAt: string;
};
const errors: Record<string, string> = {
  USERNAME_IN_USE: "该用户名已被使用，请更换。",
  INVALID_INPUT: "请检查用户名、名称及密码，密码至少 12 位。",
  FORBIDDEN: "当前账户无权管理伙伴。",
  RATE_LIMITED: "操作较多，请稍后再试。",
};
export default function PartnerAdminPanel() {
  const [rows, setRows] = useState<Partner[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [open, setOpen] = useState(false),
    [password, setPassword] = useState(""),
    [show, setShow] = useState(false);
  async function request(path: string, body?: unknown) {
    const r = await fetch("/workspace/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await r.json();
    if (!r.ok)
      throw Error(errors[result.error] ?? "操作失败，请刷新页面或重新登录。");
    return result;
  }
  async function load() {
    const result = await request("admin/partners");
    setRows(result.partners);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      await request("admin/partners", {
        username: String(form.get("username")),
        name: String(form.get("name")),
        password,
      });
      await load();
      setOpen(false);
      setPassword("");
      setNotice("伙伴账号和专属邀请链接已创建。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }
  async function toggle(p: Partner) {
    setBusy(true);
    setError("");
    try {
      await request("admin/partners/" + p.id + "/status", {
        status: p.status === "active" ? "disabled" : "active",
      });
      await load();
      setNotice(
        p.status === "active"
          ? "伙伴已停用，邀请链接不再接受新注册。"
          : "伙伴已启用，原邀请链接恢复可用。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  async function copy(p: Partner) {
    try {
      await navigator.clipboard.writeText(p.inviteUrl);
      setNotice("已复制 " + p.name + " 的邀请链接。");
    } catch {
      setNotice("请选中链接文字进行复制。");
    }
  }
  return (
    <section className="card partner-admin">
      <div className="card-heading">
        <div>
          <h2>伙伴账号与邀请</h2>
          <p>管理独立登录账号、专属邀请链接和注册归属</p>
        </div>
        <button
          className="button"
          disabled={busy}
          onClick={() => {
            setOpen(true);
            setPassword(crypto.randomUUID().replaceAll("-", "").slice(0, 16));
            setShow(false);
            setError("");
          }}
        >
          创建伙伴
        </button>
      </div>
      {!open && error && (
        <p className="note danger" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}
      {rows.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>伙伴 / 登录账号</th>
                <th>注册客户</th>
                <th>状态</th>
                <th>邀请链接</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.name}
                    <small className="partner-username">{p.username}</small>
                  </td>
                  <td>{p.customerCount}</td>
                  <td>
                    <Badge
                      status={p.status === "active" ? "available" : "suspended"}
                    >
                      {p.status === "active" ? "已启用" : "已停用"}
                    </Badge>
                  </td>
                  <td>
                    <input
                      aria-label={p.name + "的邀请链接"}
                      readOnly
                      value={p.inviteUrl}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                  </td>
                  <td>
                    <div className="actions">
                      <button
                        className="button text"
                        onClick={() => void copy(p)}
                      >
                        复制链接
                      </button>
                      <button
                        className="button outline"
                        disabled={busy}
                        onClick={() => void toggle(p)}
                      >
                        {p.status === "active" ? "停用" : "启用"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="provider-empty">
          <h3>暂无伙伴账号</h3>
          <p>创建伙伴后即可分享邀请链接。</p>
        </div>
      )}
      {open && (
        <Modal
          title="创建推广伙伴"
          busy={busy}
          onClose={() => {
            setOpen(false);
            setPassword("");
            setError("");
          }}
        >
          <form
            className="provider-action-form"
            onSubmit={(e) => void create(e)}
          >
            <label>
              伙伴名称
              <input name="name" required maxLength={100} />
            </label>
            <label>
              登录用户名
              <input
                name="username"
                required
                pattern="[a-z0-9_][a-z0-9_.-]{2,31}"
                minLength={3}
                maxLength={32}
                autoComplete="off"
                placeholder="例如 partner02"
              />
            </label>
            <label>
              初始密码
              <input
                aria-label="伙伴初始密码"
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
              />
            </label>
            <button
              className="button text"
              type="button"
              onClick={() => setShow(!show)}
            >
              {show ? "隐藏密码" : "显示密码以便保存"}
            </button>
            <p className="muted small">
              请保存初始密码并交给对应伙伴。邀请链接会自动生成。
            </p>
            {error && (
              <p role="alert" className="note danger">
                {error}
              </p>
            )}
            <button className="button" type="submit" disabled={busy}>
              {busy ? "创建中…" : "创建账号和邀请链接"}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
