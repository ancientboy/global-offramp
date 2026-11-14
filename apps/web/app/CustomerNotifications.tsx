"use client";
import { useEffect, useState } from "react";
import { Bell } from "@phosphor-icons/react";
import type { Dashboard } from "./models";
import { date, money } from "./models";
import { customerOrderState } from "./customer-order-models";
import { fundingStatus } from "./FundingDialog";
import { movementLabels } from "./money-api";
import { Modal } from "./ui";
export function customerNotices(data: Dashboard) {
  return [
    ...(data.orders ?? []).map((o) => ({
      id: `order:${o.id}:${o.payoutStatus}:${o.completionStatus}:${o.receiptStatus}`,
      title: `订单${customerOrderState(o).label}`,
      detail: o.orderNumber ?? o.id,
      time:
        o.updatedAt ??
        o.completion?.completedAt ??
        o.paymentConfirmation?.confirmedAt ??
        o.createdAt,
      orderId: o.id,
    })),
    ...(data.fundingPayments ?? []).map((p) => ({
      id: `funding:${p.id}:${p.status}:${p.credited_amount}`,
      title: `充值${fundingStatus(p.status)}`,
      detail: `${p.credited_amount ?? p.requested_amount} ${p.currency}`,
      time: p.updated_at ?? p.created_at,
      orderId: "",
    })),
    ...(data.moneyMovements ?? [])
      .filter((p) => p.kind === "refund")
      .map((p) => ({
        id: `withdrawal:${p.id}:${p.status}`,
        title: `提现${movementLabels[p.status] ?? "处理中"}`,
        detail: `${money(p.amount)} ${p.currency}${p.rejection_reason ? " · " + p.rejection_reason : ""}`,
        time: p.updated_at ?? p.created_at,
        orderId: "",
      })),
  ]
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time))
    .slice(0, 30);
}
export default function CustomerNotifications({
  accountId,
  data,
  onOrder,
  onWallet,
}: {
  accountId: string;
  data: Dashboard;
  onOrder: (id: string) => void;
  onWallet: (type: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [read, setRead] = useState<string[]>([]);
  const key = "huitu-notices-read:" + accountId;
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (Array.isArray(v))
        setRead(v.filter((x) => typeof x === "string").slice(-300));
    } catch {}
  }, [key]);
  const notices = customerNotices(data),
    unread = notices.filter((n) => !read.includes(n.id)).length;
  function markRead(ids: string[]) {
    const next = [...new Set([...read, ...ids])].slice(-300);
    setRead(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {}
  }
  return (
    <>
      <button
        className="avatar notification-trigger"
        aria-label={unread ? `消息，${unread}条未读` : "消息"}
        onClick={() => setOpen(true)}
      >
        <Bell size={20} />
        {unread > 0 && <span className="notification-count">{unread}</span>}
      </button>
      {open && (
        <Modal title="消息" busy={false} onClose={() => setOpen(false)}>
          <button
            className="button text"
            disabled={!unread}
            onClick={() => markRead(notices.map((n) => n.id))}
          >
            全部标为已读
          </button>
          {!notices.length && (
            <p>暂无消息，订单与资金进度更新后会在这里显示。</p>
          )}
          <div className="notification-list">
            {notices.map((n) => (
              <button
                key={n.id}
                className={read.includes(n.id) ? "read" : "unread"}
                onClick={() => {
                  markRead([n.id]);
                  setOpen(false);
                  n.orderId
                    ? onOrder(n.orderId)
                    : onWallet(
                        n.id.startsWith("withdrawal:") ? "refunds" : "deposits",
                      );
                }}
              >
                <strong>{n.title}</strong>
                <span>{n.detail}</span>
                <small>{date(n.time)}</small>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
