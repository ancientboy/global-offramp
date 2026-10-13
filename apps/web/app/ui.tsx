"use client";
import { Fragment, useEffect, useRef, type ReactNode } from "react";
import { Check, Info, X } from "@phosphor-icons/react";
import { labels, money, csvText, type Quote } from "./models";
export function Badge({
  status = "",
  children,
}: {
  status?: string;
  children?: ReactNode;
}) {
  const color = [
    "sent",
    "confirmed",
    "uploaded",
    "verified",
    "approved",
    "recorded",
    "valid",
    "created",
    "resolved",
    "available",
  ].includes(status)
    ? "good"
    : [
          "unknown",
          "failed",
          "error",
          "exception",
          "suspended",
          "frozen",
        ].includes(status)
      ? "bad"
      : [
            "awaiting_approval",
            "draft",
            "pending",
            "requested",
            "hold",
            "open",
          ].includes(status)
        ? "warn"
        : "neutral";
  return (
    <span className={"badge " + color}>
      {children || labels[status] || status}
    </span>
  );
}
export function Note({
  children,
  danger = false,
}: {
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className={"note " + (danger ? "danger" : "")}>
      <Info size={19} />
      <span>{children}</span>
    </div>
  );
}
export function Steps({
  active = 1,
  labels: items = ["填写付款", "确认报价", "等待入金"],
}: {
  active?: number;
  labels?: string[];
}) {
  return (
    <div className="steps">
      {items.map((item, i) => (
        <Fragment key={item}>
          <div className={i + 1 <= active ? "on" : ""}>
            <span>{i + 1 < active ? <Check size={14} /> : i + 1}</span>
            {item}
          </div>
          {i < items.length - 1 && <b />}
        </Fragment>
      ))}
    </div>
  );
}
export function FeeRows({ quote: q }: { quote: Quote }) {
  return (
    <dl className="details">
      <div>
        <dt>兑换本金</dt>
        <dd>
          {money(q.sourceAmount)} {q.sourceCurrency}
        </dd>
      </div>
      <div>
        <dt>平台服务费</dt>
        <dd>
          + {money(q.serviceFee)} {q.sourceCurrency}
        </dd>
      </div>
      <div>
        <dt>通道手续费</dt>
        <dd>
          + {money(q.channelFee)} {q.sourceCurrency}
        </dd>
      </div>
      <div className="divided">
        <dt>应入金总额</dt>
        <dd>
          <strong>
            {money(q.totalDeposit)} {q.sourceCurrency}
          </strong>
        </dd>
      </div>
      <div>
        <dt>锁定汇率</dt>
        <dd>
          1 {q.sourceCurrency} = {q.customerRate} {q.payoutCurrency}
        </dd>
      </div>
    </dl>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}
export function Modal({
  title,
  onClose,
  busy,
  children,
}: {
  title: string;
  onClose: () => void;
  busy: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-overlay" onClick={() => !busy && onClose()}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
          if (e.key === "Tab") {
            const nodes = ref.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]",
            );
            if (!nodes?.length) return;
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (
              e.shiftKey &&
              (document.activeElement === first ||
                document.activeElement === ref.current)
            ) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <button
          className="close"
          aria-label="关闭"
          disabled={busy}
          onClick={onClose}
        >
          <X size={22} />
        </button>
        <h2 id="dialog-title">{title}</h2>
        {children}
      </div>
    </div>
  );
}
export function downloadCSV(name: string, rows: string[][]) {
  const blob = new Blob(["\uFEFF" + csvText(rows)], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
