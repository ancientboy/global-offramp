"use client";
import AccountMenu from "./AccountMenu";
import { providerQueue } from "./experience-models";
import ProviderReceipt, { type ReceiptInfo } from "./ProviderReceipt";
import { prepareReceipt } from "./receipt-upload";
import { PortalBrand } from "./Brand";
import { useContext, useEffect, useRef, useState } from "react";
import { WorkspaceContext } from "./workspace-context";
import { Badge, Modal } from "./ui";
import SelectField from "./SelectField";
import {
  accountFields,
  OPTION_NAMES,
  type FullRecipientInput,
} from "../../../packages/core/src/recipient-account";
import { money } from "./models";
import {
  initialPaymentTime,
  localPaymentInput,
  providerDate as date,
} from "./provider-time";
type Order = {
  id: string;
  orderNumber: string;
  createdAt: string;
  serverTime?: string;
  recipientDetails?: Pick<FullRecipientInput, "method" | "fields">;
  payoutCurrency: string;
  payoutAmount: string;
  payoutStatus: string;
  receiptStatus: string;
  receiptFile?: ReceiptInfo | null;
  depositStatus: string;
  canRecordPayment: boolean;
  recipient: null | { name: string; country: string; accountMasked: string };
  processingRecordId?: string | null;
  paymentConfirmation: null | {
    actualAmount: string;
    paidAt: string;
    providerReference: string | null;
    internalRecordId?: string | null;
  };
};
type Data = {
  provider: { id: string; name: string; routes: string[] };
  orders: Order[];
};
const errors: Record<string, string> = {
  MFA_SETUP_REQUIRED: "请先在账户安全中开启二次验证。",
  MFA_STEP_UP_REQUIRED: "请在账户安全中验证动态码后重试。",
  PASSWORD_CHANGE_REQUIRED: "请先在账户安全中更换初始密码。",
  PAYOUTS_PAUSED: "付款处理暂时暂停，请联系管理员。",
  CUSTOMER_BLOCKED: "该客户资金正在核对，暂不能处理。",
  UNSAFE_FILE: "回单未通过安全扫描，请更换文件。",
  SCAN_BUSY: "文件扫描繁忙，请稍后重试。",
  SCAN_UNAVAILABLE: "文件安全检查暂不可用，请稍后重试。",
  FUNDS_NOT_READY: "订单尚未入金，暂不能登记付款。",
  PAYOUT_LOCKED: "订单状态已变化，或结果仍待核实，请刷新后处理。",
  FORBIDDEN: "当前账号无权处理该订单。",
  NOT_FOUND: "订单不存在或未分配给当前服务商。",
  PAYOUT_AMOUNT_MISMATCH: "付款金额必须与订单金额一致。",
  INVALID_PAYMENT_TIME: "付款时间应在下单之后，且不能晚于当前时间。",
  DUPLICATE_REFERENCE: "该付款参考号已登记，请核对后重试。",
  INVALID_FILE: "回单须为 PNG、JPG 或 PDF，且不超过 2 MB。",
  INVALID_STATE: "当前订单状态不支持此操作。",
  IDEMPOTENCY_CONFLICT: "本次操作内容已变化，请返回详情并重新登记。",
  OPEN_DISCREPANCY: "订单存在待核实差异，请联系管理员处理。",
  REFUND_CONFLICT: "订单存在退款申请，请联系管理员处理。",
  PROVIDER_UNAVAILABLE: "服务商已停用，请联系管理员。",
};
const status = (o: Order) =>
  ({
    ready: "可付款",
    waiting: "等待平台确认",
    sent: "已登记付款",
    unknown: "待核实",
    cancelled: "已取消",
    failed: "付款未完成",
  })[providerQueue(o)] ?? "处理中";
const pending = (o: Order) =>
  ["draft", "approved", "awaiting_approval"].includes(o.payoutStatus);
export default function ProviderPortal() {
  const workspace = useContext(WorkspaceContext)!;
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState("ready"),
    [selected, setSelected] = useState<Order | null>(null),
    [action, setAction] = useState<"sent" | "unknown" | null>(null);
  const [reference, setReference] = useState(""),
    [paidAt, setPaidAt] = useState(""),
    [evidence, setEvidence] = useState(""),
    [checked, setChecked] = useState(false);
  const timeAnchor = useRef({
    serverTime: new Date().toISOString(),
    observed: Date.now(),
  });
  const key = useRef(""),
    inFlight = useRef(false);
  async function request(path: string, body?: unknown) {
    const r = await fetch("/workspace/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (r.status === 401) {
      workspace.expired();
      throw Error("登录已过期，请重新登录。");
    }
    const result = await r.json();
    if (!r.ok)
      throw Error(errors[result.error] ?? "操作未完成，请刷新订单后重试。");
    return result;
  }
  async function load(silent = false) {
    if (!silent) setBusy(true);
    setError("");
    try {
      setData(await request("dashboard"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      if (!silent) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const t = setInterval(() => {
      if (!document.hidden && !selected && !inFlight.current) void load(true);
    }, 30000);
    return () => clearInterval(t);
  }, [!!selected]);
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("已复制");
    } catch {
      setError("复制失败，请选中文字复制。");
    }
  }
  async function open(order: Order) {
    setError("");
    setNotice("");
    setBusy(true);
    setAction(null);
    try {
      const detail = await request("provider/orders/" + order.id);
      timeAnchor.current = {
        serverTime: detail.serverTime ?? new Date().toISOString(),
        observed: Date.now(),
      };
      setSelected(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取失败");
    } finally {
      setBusy(false);
    }
  }
  function begin(outcome: "sent" | "unknown") {
    setAction(outcome);
    key.current = crypto.randomUUID();
    setReference("");
    setPaidAt(
      initialPaymentTime(
        selected!.createdAt,
        timeAnchor.current.serverTime,
        Date.now() - timeAnchor.current.observed,
      ),
    );
    setEvidence("");
    setChecked(false);
    setError("");
  }
  async function record(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !action || !checked || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const input = {
        idempotencyKey: key.current,
        outcome: action,
        ...(evidence.trim() ? { evidence: evidence.trim() } : {}),
        ...(reference.trim() ? { providerReference: reference.trim() } : {}),
        ...(action === "sent"
          ? {
              actualAmount: selected.payoutAmount,
              paidAt: new Date(paidAt).toISOString(),
            }
          : {}),
      };
      const order = await request(
        "provider/orders/" + selected.id + "/payment",
        input,
      );
      setSelected(order);
      setData(await request("dashboard"));
      setAction(null);
      if (filter === "ready") setFilter(action === "sent" ? "sent" : "unknown");
      setNotice(
        action === "sent"
          ? "付款结果已登记，订单状态已更新。"
          : "订单已标记待核实，禁止重复付款，请联系管理员核对。",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "登记失败");
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  async function upload(file: File) {
    if (!selected || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      file = await prepareReceipt(file);
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(Error("文件读取失败"));
        reader.readAsDataURL(file);
      });
      const order = await request(
        "provider/orders/" + selected.id + "/receipt",
        { fileName: file.name, contentType: file.type, dataBase64 },
      );
      setSelected(order);
      setData(await request("dashboard"));
      if (filter === "ready") setFilter("sent");
      setNotice("回单已保存。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "上传失败");
    } finally {
      setBusy(false);
      inFlight.current = false;
    }
  }
  const rows = (data?.orders ?? [])
    .filter((o) => filter === "all" || providerQueue(o) === filter)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return (
    <main className="provider-portal">
      <PortalBrand area="出款服务商" code="PAYOUT OPERATIONS" />
      <header className="provider-top">
        <div>
          <span className="admin-eyebrow">汇途 · 出款服务商</span>
          <h1>{data?.provider.name ?? workspace.account.name}</h1>
          <p>处理分配给您的出款订单</p>
        </div>
        <div className="actions">
          <button
            className="button outline"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? "读取中…" : "刷新订单"}
          </button>
          <AccountMenu disabled={busy} onError={setError} />
        </div>
      </header>
      {!selected && error && (
        <p role="alert" className="note danger">
          {error}
        </p>
      )}
      {!selected && notice && (
        <p role="status" className="note">
          {notice}
        </p>
      )}
      {data && (
        <>
          <section className="provider-summary">
            <div className="card">
              <span>可付款订单</span>
              <strong>
                {data.orders.filter((o) => providerQueue(o) === "ready").length}
              </strong>
              <button className="link" onClick={() => setFilter("ready")}>
                立即处理
              </button>
            </div>
            <div className="card">
              <span>等待平台确认</span>
              <strong>
                {
                  data.orders.filter((o) => providerQueue(o) === "waiting")
                    .length
                }
              </strong>
              <button className="link" onClick={() => setFilter("waiting")}>
                查看等待订单
              </button>
            </div>
            <div className="card">
              <span>待核实订单</span>
              <strong>
                {data.orders.filter((o) => o.payoutStatus === "unknown").length}
              </strong>
            </div>
          </section>
          <section className="card">
            <div className="card-heading">
              <h2>出款订单</h2>
              <div className="provider-filter">
                <SelectField
                  aria-label="筛选出款订单"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="ready">可付款</option>
                  <option value="waiting">等待平台确认</option>
                  <option value="unknown">待核实</option>
                  <option value="sent">已登记付款</option>
                  <option value="cancelled">已取消</option>
                  <option value="all">全部订单</option>
                </SelectField>
              </div>
            </div>
            {rows.length ? (
              <div className="provider-orders">
                <table>
                  <thead>
                    <tr>
                      <th>订单</th>
                      <th>收款人</th>
                      <th>出款金额</th>
                      <th>付款状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((o) => (
                      <tr key={o.id}>
                        <td>
                          <button
                            className="link"
                            disabled={busy}
                            onClick={() => void open(o)}
                          >
                            {o.orderNumber}
                          </button>
                          <small>{date(o.createdAt)}</small>
                        </td>
                        <td>
                          <span className="provider-mobile-label">收款人</span>
                          {o.recipient?.name ?? "—"}
                          <small>{o.recipient?.accountMasked ?? "—"}</small>
                        </td>
                        <td>
                          <span className="provider-mobile-label">
                            出款金额
                          </span>
                          {money(o.payoutAmount)} {o.payoutCurrency}
                        </td>
                        <td>
                          <Badge status={o.payoutStatus}>{status(o)}</Badge>
                          {o.receiptFile && <small>回单已上传</small>}
                        </td>
                        <td>
                          <button
                            className="button outline"
                            disabled={busy}
                            onClick={() => void open(o)}
                          >
                            {o.canRecordPayment ? "查看 / 处理" : "查看详情"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="provider-empty">
                <h3>暂无{filter === "ready" ? "可付款" : "该状态"}订单</h3>
                <p>订单状态更新后，可刷新列表查看。</p>
              </div>
            )}
          </section>
        </>
      )}
      {selected && (
        <Modal
          title={"订单 " + selected.orderNumber}
          busy={busy}
          onClose={() => {
            setSelected(null);
            setAction(null);
            setError("");
          }}
        >
          <div className="provider-detail">
            <Badge status={selected.payoutStatus}>{status(selected)}</Badge>
            <dl className="details">
              <div>
                <dt>出款金额</dt>
                <dd>
                  <strong>
                    {money(selected.payoutAmount)} {selected.payoutCurrency}
                  </strong>
                  <button
                    className="button text copy-field"
                    onClick={() => void copy(selected.payoutAmount)}
                  >
                    复制金额
                  </button>
                </dd>
              </div>
              <div>
                <dt>收款人</dt>
                <dd>{selected.recipient?.name ?? "—"}</dd>
              </div>
              <div>
                <dt>收款账户尾号</dt>
                <dd>{selected.recipient?.accountMasked ?? "—"}</dd>
              </div>
              <div>
                <dt>收款地区</dt>
                <dd>
                  {selected.recipient
                    ? new Intl.DisplayNames(["zh-CN"], { type: "region" }).of(
                        selected.recipient.country,
                      )
                    : "—"}
                </dd>
              </div>
              <div>
                <dt>入金状态</dt>
                <dd>
                  {selected.depositStatus === "confirmed" ? "已确认" : "未确认"}
                </dd>
              </div>
              <div>
                <dt>下单时间</dt>
                <dd>{date(selected.createdAt)}</dd>
              </div>
            </dl>
            {error && (
              <p role="alert" className="note danger">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="note">
                {notice}
              </p>
            )}
            {selected.recipientDetails && (
              <section className="card">
                <h3>完整收款资料</h3>
                <dl className="details">
                  {accountFields(selected.recipientDetails.method)
                    .filter((f) => selected.recipientDetails!.fields[f.id])
                    .map((f) => (
                      <div key={f.id}>
                        <dt>{f.label}</dt>
                        <dd style={{ overflowWrap: "anywhere" }}>
                          {OPTION_NAMES[
                            selected.recipientDetails!.fields[f.id]
                          ] ?? selected.recipientDetails!.fields[f.id]}
                          <button
                            className="button text copy-field"
                            aria-label={"复制" + f.label}
                            onClick={() =>
                              void copy(selected.recipientDetails!.fields[f.id])
                            }
                          >
                            复制
                          </button>
                        </dd>
                      </div>
                    ))}
                </dl>
              </section>
            )}
            {selected.paymentConfirmation && (
              <section className="provider-payment">
                <h3>付款登记</h3>
                {selected.processingRecordId && (
                  <p>处理记录号：{selected.processingRecordId}</p>
                )}
                {selected.paymentConfirmation.providerReference && (
                  <p>
                    外部付款流水号：
                    {selected.paymentConfirmation.providerReference}
                  </p>
                )}
                <p>付款时间：{date(selected.paymentConfirmation.paidAt)}</p>
                <p>
                  登记金额：{money(selected.paymentConfirmation.actualAmount)}{" "}
                  {selected.payoutCurrency}
                </p>
              </section>
            )}
            {action ? (
              <form
                onSubmit={(e) => void record(e)}
                className="provider-action-form"
              >
                <h3>
                  {action === "sent" ? "登记线下付款结果" : "标记结果待核实"}
                </h3>
                <p className="muted small">
                  此处只登记处理结果，不会发起银行或链上转账。
                  {!selected.recipientDetails &&
                    "此历史账户仅有尾号，请先核实完整收款资料。"}
                </p>
                {action === "sent" && (
                  <>
                    <label>
                      付款金额
                      <input
                        aria-label="付款金额"
                        value={
                          selected.payoutAmount + " " + selected.payoutCurrency
                        }
                        readOnly
                      />
                    </label>
                    <label>
                      付款时间（本地时间）
                      <input
                        aria-label="付款时间"
                        type="datetime-local"
                        step="0.001"
                        min={
                          selected
                            ? localPaymentInput(new Date(selected.createdAt))
                            : undefined
                        }
                        required
                        value={paidAt}
                        onChange={(e) => setPaidAt(e.target.value)}
                        disabled={busy}
                      />
                    </label>
                  </>
                )}
                <label>
                  处理记录号
                  <input
                    aria-label="处理记录号"
                    readOnly
                    value={selected.processingRecordId ?? "提交后自动生成"}
                  />
                </label>
                <label>
                  外部付款流水号（选填）
                  <input
                    aria-label="外部付款流水号"
                    maxLength={100}
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <label>
                  付款说明（选填）
                  <textarea
                    aria-label="付款说明"
                    maxLength={1000}
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                    disabled={busy}
                  />
                </label>
                <label className="provider-check">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => setChecked(e.target.checked)}
                    disabled={busy}
                  />
                  <span>
                    {action === "sent"
                      ? "我已核对收款人和金额，并确认线下付款结果。"
                      : "当前付款结果仍需核实，不会重复发起付款。"}
                  </span>
                </label>
                <div className="actions sticky-actions">
                  <button
                    type="button"
                    className="button outline"
                    disabled={busy}
                    onClick={() => setAction(null)}
                  >
                    返回详情
                  </button>
                  <button
                    type="submit"
                    className="button"
                    disabled={busy || !checked}
                  >
                    {busy
                      ? "提交中…"
                      : action === "sent"
                        ? "确认登记已付款"
                        : "确认标记待核实"}
                  </button>
                </div>
              </form>
            ) : (
              <>
                {selected.canRecordPayment ? (
                  <div className="actions sticky-actions">
                    <button
                      className="button"
                      disabled={busy}
                      onClick={() => begin("sent")}
                    >
                      登记已付款
                    </button>
                    <button
                      className="button outline"
                      disabled={busy}
                      onClick={() => begin("unknown")}
                    >
                      结果待核实
                    </button>
                  </div>
                ) : selected.payoutStatus === "unknown" ? (
                  <p className="note">
                    结果待核实，订单已锁定。请联系管理员核对后处理，避免重复付款。
                  </p>
                ) : pending(selected) ? (
                  <p className="note">
                    订单尚不满足付款条件，正在等待平台确认。请将订单号提供给管理员核对，勿提前付款。
                    <button
                      className="button text"
                      onClick={() => void copy(selected.orderNumber)}
                    >
                      复制订单号
                    </button>
                  </p>
                ) : null}
                {selected.payoutStatus === "sent" && (
                  <ProviderReceipt
                    orderId={selected.id}
                    receipt={selected.receiptFile}
                    busy={busy}
                    onUpload={upload}
                    onExpired={workspace.expired}
                  />
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </main>
  );
}
