"use client";
import { useContext, useEffect, useRef, useState } from "react";
import { UserCircle, CaretDown } from "@phosphor-icons/react";
import { WorkspaceContext } from "./workspace-context";
import { Modal } from "./ui";
import "./account-menu.css";
export default function AccountMenu({
  onProfile,
  onWithdraw,
  disabled = false,
  onError,
}: {
  onProfile?: () => void;
  onWithdraw?: () => void;
  disabled?: boolean;
  onError?: (message: string) => void;
}) {
  const workspace = useContext(WorkspaceContext),
    [open, setOpen] = useState(false),
    [profile, setProfile] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function outside(e: PointerEvent) {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    }
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  if (!workspace) return null;
  const { account } = workspace;
  function choose(fn: () => void) {
    setOpen(false);
    fn();
  }
  async function logout() {
    setBusy(true);
    try {
      await workspace!.logout();
    } catch {
      setBusy(false);
      setError("退出失败，请重试。");
      onError?.("退出失败，请重试。");
    }
  }
  return (
    <div className="account-menu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="account-menu-trigger"
        aria-label="个人菜单"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled || busy}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setTimeout(
              () =>
                root.current
                  ?.querySelector<HTMLButtonElement>("[role=menuitem]")
                  ?.focus(),
              0,
            );
          }
        }}
      >
        <UserCircle size={24} />
        <span>{account.name}</span>
        <CaretDown size={14} />
      </button>
      {open && (
        <div
          className="account-menu-panel"
          role="menu"
          aria-label="个人菜单"
          onKeyDown={(e) => {
            const nodes = Array.from(
                e.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "[role=menuitem]",
                ),
              ),
              index = nodes.indexOf(
                document.activeElement as HTMLButtonElement,
              );
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              nodes[
                (index + (e.key === "ArrowDown" ? 1 : -1) + nodes.length) %
                  nodes.length
              ]?.focus();
            }
            if (e.key === "Home") {
              e.preventDefault();
              nodes[0]?.focus();
            }
            if (e.key === "End") {
              e.preventDefault();
              nodes.at(-1)?.focus();
            }
          }}
        >
          <p>{account.username || account.email || account.name}</p>
          <button
            role="menuitem"
            onClick={() =>
              choose(() => (onProfile ? onProfile() : setProfile(true)))
            }
          >
            {account.role === "customer" ? "用户详情" : "个人资料"}
          </button>
          {onWithdraw && (
            <button role="menuitem" onClick={() => choose(onWithdraw)}>
              提现
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => choose(() => workspace.openSecurity?.())}
          >
            账户安全
          </button>
          <button
            role="menuitem"
            className="account-logout"
            disabled={busy}
            onClick={() => void logout()}
          >
            {busy ? "正在退出…" : "退出登录"}
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
      )}
      {profile && (
        <Modal title="个人资料" busy={false} onClose={() => setProfile(false)}>
          <dl className="details">
            <div>
              <dt>账户名称</dt>
              <dd>{account.name}</dd>
            </div>
            <div>
              <dt>登录账号</dt>
              <dd>{account.username || account.email}</dd>
            </div>
            <div>
              <dt>账号类型</dt>
              <dd>
                {
                  {
                    merchant_admin: "管理员",
                    payout_provider: "出款服务商",
                    partner: "推广伙伴",
                    customer: "客户",
                  }[account.role]
                }
              </dd>
            </div>
            {account.createdAt && (
              <div>
                <dt>注册时间</dt>
                <dd>
                  {new Date(account.createdAt).toLocaleString("zh-CN", {
                    timeZone: "Asia/Shanghai",
                    hour12: false,
                  })}{" "}
                  北京时间
                </dd>
              </div>
            )}
          </dl>
        </Modal>
      )}
    </div>
  );
}
