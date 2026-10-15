"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowLeft,
  ArrowUpRight,
  ArrowsClockwise,
  Bank,
  CheckCircle,
  Clock,
  CurrencyCircleDollar,
  Download,
  FileText,
  Files,
  Info,
  Lock,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  User,
  Users,
  Wallet,
  WarningCircle,
  PaperPlaneTilt,
  ChartBar,
  Question,
  ClipboardText,
  Database,
} from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { Badge, Note, Steps, FeeRows, Empty, Modal, downloadCSV } from "./ui";
import {
  money,
  quoteAmountInput,
  validQuoteAmount,
  canResetDemoSession,
  percentage,
  shortId,
  date,
  symbol,
  type ActorKey,
  type ViewRole,
  type Quote,
  type Order,
  type Dashboard,
  type Health,
  type BatchResult,
  type Audit,
} from "./models";

type Page =
  | "payment"
  | "recipients"
  | "orders"
  | "detail"
  | "certification"
  | "workbench"
  | "pricing"
  | "reconciliation"
  | "audit"
  | "partner"
  | "clients"
  | "commissions"
  | "settlements";
type Field = {
  key: string;
  label: string;
  value: string;
  type?: "text" | "textarea" | "select" | "month";
  options?: [string, string][];
};
type Command = {
  title: string;
  description: string;
  path: string;
  base?: Record<string, string>;
  fields?: Field[];
  button: string;
  success: string;
};
const navs: Record<ViewRole, [Page, string, Icon][]> = {
  customer: [
    ["payment", "付款", Wallet],
    ["recipients", "收款人", User],
    ["orders", "订单记录", FileText],
    ["certification", "身份认证", ShieldCheck],
  ],
  admin: [
    ["workbench", "出款工作台", Wallet],
    ["recipients", "收款人白名单", User],
    ["certification", "客户审核", ShieldCheck],
    ["pricing", "汇率与费率", SlidersHorizontal],
    ["reconciliation", "财务对账", ClipboardText],
    ["settlements", "佣金结算", CurrencyCircleDollar],
    ["audit", "操作记录", Clock],
  ],
  partner: [
    ["partner", "伙伴中心", Users],
    ["clients", "我的客户", User],
    ["commissions", "佣金明细", CurrencyCircleDollar],
    ["settlements", "结算记录", FileText],
  ],
};
const titles: Record<Page, string> = {
  payment: "创建付款",
  recipients: "收款人",
  orders: "订单记录",
  detail: "订单详情",
  certification: "身份认证",
  workbench: "出款工作台",
  pricing: "汇率与费率",
  reconciliation: "财务对账",
  audit: "操作记录",
  partner: "合作伙伴中心",
  clients: "我的客户",
  commissions: "佣金明细",
  settlements: "结算记录",
};
const subtitles: Record<Page, string> = {
  payment: "使用稳定币，向已验证的银行账户付款",
  recipients: "管理可信任的收款账户，管理员审核后可用",
  orders: "资金到账、换汇、出款与回单，分别追踪",
  detail: "每一步资金状态，都有清晰记录",
  certification: "来自服务端的演示客户审核状态",
  workbench: "查看入金、登记线下付款、上传回单，一处完成",
  pricing: "服务端样例配置与不可覆盖的报价快照",
  reconciliation: "核对模拟渠道参考号、金额与证据",
  audit: "来自服务端的脱敏操作记录",
  partner: "查看服务费佣金与月度结算",
  clients: "仅显示已产生佣金记录的脱敏客户",
  commissions: "按对账后的服务费计提，保留退款调整",
  settlements: "服务端结算草稿与批准记录",
};
const actors: [ActorKey, string][] = [
  ["customer-demo", "客户 · 个人"],
  ["company-demo", "客户 · 企业"],
  ["admin-demo", "商家 · 管理员"],
  ["partner-demo", "合作伙伴"],
];
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "请求失败，请重试";
const uid = () => crypto.randomUUID();

export default function Home() {
  const [actor, setActor] = useState<ActorKey>("customer-demo");
  const actorRef = useRef(actor);
  actorRef.current = actor;
  const role: ViewRole =
    actor === "partner-demo"
      ? "partner"
      : ["customer-demo", "company-demo"].includes(actor)
        ? "customer"
        : "admin";
  const finance = actor === "admin-demo";
  const maker = actor === "admin-demo";
  const [page, setPage] = useState<Page>("payment");
  const [dataState, setDataState] = useState<{
    actor: ActorKey;
    value: Dashboard;
  } | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [connection, setConnection] = useState<
    "loading" | "connected" | "error"
  >("loading");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const reloadId = useRef(0);
  const [support, setSupport] = useState(false);
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState("single");
  const [enteredAmount, setEnteredAmount] = useState("100000.00");
  const [amountMode, setAmountMode] = useState<
    "total_deposit" | "target_payout"
  >("target_payout");
  const [asset, setAsset] = useState("USDT");
  const [market, setMarket] = useState("CNY");
  const [beneficiaryId, setBeneficiaryId] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [quoteVersion, setQuoteVersion] = useState(0);
  const [checked, setChecked] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [command, setCommand] = useState<Command | null>(null);
  const [commandValues, setCommandValues] = useState<Record<string, string>>(
    {},
  );
  const [commandError, setCommandError] = useState("");
  const [batchText, setBatchText] = useState("");
  const [batch, setBatch] = useState<BatchResult | null>(null);
  const [batchKey, setBatchKey] = useState("");
  const [audits, setAudits] = useState<Audit[] | null>(null);
  const [auditError, setAuditError] = useState("");
  const [pricingMarket, setPricingMarket] = useState("CNY");
  const data =
    dataState?.actor === actor && connection === "connected"
      ? dataState.value
      : null;
  const orders = data?.orders ?? [],
    beneficiaries = data?.beneficiaries ?? [],
    customers = data?.customers ?? [];
  const customerId = actor === "company-demo" ? "customer-2" : "customer-1";
  const currentCustomer = customers.find((c) => c.id === customerId);
  const approvedBeneficiaries = beneficiaries.filter(
    (b) =>
      b.customerId === customerId &&
      b.status === "approved" &&
      b.currency === market,
  );
  const recipient =
    approvedBeneficiaries.find((b) => b.id === beneficiaryId) ??
    approvedBeneficiaries[0];
  const chosenBeneficiaryId = recipient?.id ?? "";
  const order = orders.find((o) => o.id === selected) ?? orders[0];
  const commissionRows = data?.commissions ?? [];
  const settlementRows = data?.settlements ?? [];
  const usable = connection === "connected" && !!data;
  const locked = busy || !usable;
  const remaining = quote
    ? Math.max(
        0,
        Math.floor((new Date(quote.expiresAt).getTime() - now) / 1000),
      )
    : 0;

  const request = useCallback(
    async <T,>(
      path: string,
      body?: unknown,
      signal?: AbortSignal,
    ): Promise<T> => {
      const response = await fetch("/api/" + path, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json", "x-demo-actor": actor },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) {
        if (result?.error === "SESSION_EXPIRED" && actorRef.current === actor) {
          // Never replay a mutation into a newly created session. Require a fresh, explicit dashboard read.
          reloadId.current += 1;
          setDataState(null);
          setConnection("error");
          setQuote(null);
          setStep(1);
          setChecked(false);
          setBatch(null);
          setBatchText("");
          setBatchKey("");
          setAudits(null);
          setSelected("");
          setToast("");
          setCommand(null);
          setCommandValues({});
          setError(
            result.message ??
              "演示会话已失效，请刷新服务器数据以开始新的空白会话。",
          );
        }
        const details = result?.issues
          ?.map(
            (i: { path: string[]; message: string }) =>
              `${i.path.join(".")}: ${i.message}`,
          )
          .join("；");
        throw new Error(
          result?.message ??
            details ??
            result?.error ??
            `API 请求失败 (${response.status})`,
        );
      }
      if (result === null) throw new Error("API 未返回可读取的数据");
      return result as T;
    },
    [actor],
  );

  const reload = useCallback(async () => {
    const id = ++reloadId.current;
    try {
      const [h, d] = await Promise.all([
        request<Health>("health"),
        request<Dashboard>("dashboard"),
      ]);
      if (id !== reloadId.current || actorRef.current !== actor) return;
      if (
        h.mode !== "MOCK" ||
        h.realExecutionEnabled !== false ||
        h.status !== "ok"
      )
        throw new Error("后端未通过 MOCK 安全健康检查，操作已停用");
      setHealth(h);
      setDataState({ actor, value: d });
      setConnection("connected");
      setError("");
    } catch (e) {
      if (id !== reloadId.current || actorRef.current !== actor) return;
      setConnection("error");
      setDataState(null);
      setHealth(null);
      setError(errorText(e));
    }
  }, [actor, request]);

  useEffect(() => {
    setDataState(null);
    setHealth(null);
    setConnection("loading");
    setQuote(null);
    setStep(1);
    setChecked(false);
    setBatch(null);
    setBatchText("");
    setBatchKey("");
    setAudits(null);
    setAuditError("");
    setError("");
    void reload();
    return () => {
      reloadId.current += 1;
    };
  }, [reload]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Quote values always come from the server. Editing the form invalidates the displayed snapshot.
  useEffect(() => {
    if (
      role !== "customer" ||
      page !== "payment" ||
      step !== 1 ||
      mode !== "single"
    )
      return;
    setQuote(null);
    setQuoteError("");
    if (
      !usable ||
      !chosenBeneficiaryId ||
      currentCustomer?.status !== "approved"
    ) {
      setQuoteBusy(false);
      return;
    }
    if (!validQuoteAmount(amountMode, enteredAmount)) {
      setQuoteError(
        amountMode === "target_payout"
          ? "请输入法币金额，最多 2 位小数"
          : "请输入稳定币金额，最多 6 位小数",
      );
      setQuoteBusy(false);
      return;
    }
    const controller = new AbortController();
    setQuoteBusy(true);
    const timer = setTimeout(() => {
      void request<Quote>(
        "quotes",
        {
          customerId,
          beneficiaryId: chosenBeneficiaryId,
          sourceCurrency: asset,
          ...quoteAmountInput(amountMode, enteredAmount, market),
        },
        controller.signal,
      )
        .then((q) => {
          if (!controller.signal.aborted) {
            setQuote(q);
            setNow(Date.now());
          }
        })
        .catch((e) => {
          if (!controller.signal.aborted) setQuoteError(errorText(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setQuoteBusy(false);
        });
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    role,
    page,
    step,
    mode,
    usable,
    chosenBeneficiaryId,
    currentCustomer?.status,
    enteredAmount,
    amountMode,
    market,
    asset,
    customerId,
    request,
    quoteVersion,
  ]);

  useEffect(() => {
    if (page !== "audit" || !usable || (!finance && actor !== "auditor-demo"))
      return;
    const controller = new AbortController();
    setAudits(null);
    setAuditError("");
    void request<Audit[]>("audit", undefined, controller.signal)
      .then(setAudits)
      .catch((e) => {
        if (!controller.signal.aborted) setAuditError(errorText(e));
      });
    return () => controller.abort();
  }, [page, usable, finance, actor, request, dataState]);

  async function mutate<T>(
    path: string,
    body: unknown,
    message: string,
  ): Promise<T | null> {
    if (busyRef.current || !usable) return null;
    busyRef.current = true;
    setBusy(true);
    setToast("");
    setError("");
    setCommandError("");
    try {
      const result = await request<T>(path, body);
      if (actorRef.current !== actor) return null;
      if (path === "demo/reset") {
        // Clear the old session view only after the server confirms the scoped reset.
        // The server alone preserves its session expiry and request-rate counters.
        reloadId.current += 1;
        setDataState(null);
        setConnection("loading");
        setQuote(null);
        setQuoteError("");
        setQuoteBusy(false);
        setStep(1);
        setChecked(false);
        setBatch(null);
        setBatchText("");
        setBatchKey("");
        setAudits(null);
        setAuditError("");
        setSelected("");
        setBeneficiaryId("");
        setFilter("all");
        setSearch("");
        setCommand(null);
        setCommandValues({});
      }
      setToast(message);
      await reload();
      return result;
    } catch (e) {
      setError(errorText(e));
      setCommandError(errorText(e));
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function go(next: Page) {
    setPage(next);
    setFilter("all");
    setSearch("");
    setCommand(null);
    window.scrollTo(0, 0);
  }
  function changeActor(next: ActorKey) {
    if (busyRef.current) return;
    const nextRole =
      next === "partner-demo"
        ? "partner"
        : ["customer-demo", "company-demo"].includes(next)
          ? "customer"
          : "admin";
    setCommand(null);
    setActor(next);
    setMarket(next === "company-demo" ? "USD" : "CNY");
    setBeneficiaryId("");
    setSupport(false);
    setQuote(null);
    if (nextRole !== role) go(navs[nextRole][0][0]);
  }
  function editForm(edit: () => void) {
    setQuote(null);
    setChecked(false);
    edit();
  }
  function openCommand(cmd: Command) {
    setCommand(cmd);
    setCommandError("");
    setCommandValues(
      Object.fromEntries((cmd.fields ?? []).map((f) => [f.key, f.value])),
    );
  }
  async function submitCommand() {
    if (!command) return;
    const result = await mutate(
      command.path,
      { ...command.base, ...commandValues },
      command.success,
    );
    if (result !== null) setCommand(null);
  }
  async function createOrder() {
    if (!quote || !checked || remaining === 0) return;
    const result = await mutate<Order>(
      "orders",
      { quoteId: quote.id, clientOrderId: "web_" + quote.id },
      "订单已在服务端创建，等待 MOCK 入金事件。",
    );
    if (result) {
      setSelected(result.id);
      setStep(3);
    }
  }
  function template(withErrors = false) {
    const available = beneficiaries.filter(
      (b) => b.customerId === customerId && b.status === "approved",
    );
    const token = uid().slice(0, 8);
    return (
      "clientItemId,beneficiaryId,sourceCurrency,sourceAmount\n" +
      available
        .map((b, i) => `DEMO-${token}-${i + 1},${b.id},USDT,1000.00`)
        .join("\n") +
      (withErrors ? `\nDEMO-${token}-BAD,missing-beneficiary,USDT,50.00` : "")
    );
  }
  async function importBatch() {
    const key = batchKey || "web_batch_" + uid();
    setBatchKey(key);
    const result = await mutate<BatchResult>(
      "batches",
      { customerId, clientBatchId: key, csv: batchText },
      "服务端逐行校验完成，请核对有效行与错误行。",
    );
    if (result) setBatch(result);
  }
  async function submitBatch() {
    if (!batch) return;
    const result = await mutate<BatchResult>(
      `batches/${batch.batch.id}/submit`,
      {},
      "有效行已创建订单。每笔订单仍需独立入金、出款与对账。",
    );
    if (result) setBatch(result);
  }
  const evidence = (value: string): Field => ({
    key: "evidence",
    label: "MOCK 核验依据（仅虚构资料）",
    value,
    type: "textarea",
  });
  const reference = (value: string): Field => ({
    key: "providerReference",
    label: "模拟渠道参考号",
    value,
  });
  function resetSession() {
    if (!canResetDemoSession(actor, health?.persistence)) return;
    openCommand({
      title: "重置当前会话演示数据？",
      description:
        "这会丢弃当前隔离会话内的虚构订单、报价、批次、退款、佣金及操作记录，并恢复预置演示客户与收款人。操作不可撤销，仅影响当前会话的合成数据，不涉及真实资金或其他会话。重置不会延长会话有效期，也不会重置请求次数限制。",
      path: "demo/reset",
      base: { confirm: "reset-synthetic-session" },
      button: "确认重置当前会话",
      success: "当前会话的合成数据已重置。",
    });
  }
  function seedScenario() {
    openCommand({
      title: "创建服务端 MOCK 场景",
      description:
        "服务端通过领域方法创建三笔关联样例：已入金待付款、待记录付款结果、已对账待观察期佣金。再次点击返回同一组样例，不重置或覆盖已有订单。",
      path: "demo/scenario",
      base: { idempotencyKey: "workspace-default-v1" },
      button: "创建 MOCK 场景",
      success: "服务端 MOCK 场景已准备好，可切换角色验证后续流程。",
    });
  }
  function orderTable() {
    const visible = orders.filter(
      (o) =>
        (filter === "all" ||
          (filter === "pending"
            ? !["sent", "cancelled"].includes(o.payoutStatus)
            : o.payoutStatus === "sent")) &&
        (
          o.id +
          o.clientOrderId +
          (beneficiaries.find((b) => b.id === o.quote.beneficiaryId)?.name ??
            "")
        )
          .toLowerCase()
          .includes(search.toLowerCase()),
    );
    return (
      <div className="card table-card">
        <div className="table-tools">
          <div className="tabs">
            {[
              ["pending", "待处理"],
              ["sent", "已发送"],
              ["all", "全部订单"],
            ].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? "active" : ""}
                onClick={() => setFilter(value)}
              >
                {label}
                <em>
                  {
                    orders.filter(
                      (o) =>
                        value === "all" ||
                        (value === "sent"
                          ? o.payoutStatus === "sent"
                          : !["sent", "cancelled"].includes(o.payoutStatus)),
                    ).length
                  }
                </em>
              </button>
            ))}
          </div>
          <input
            className="search"
            aria-label="搜索订单"
            placeholder="搜索订单号 / 收款人"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>订单</th>
                <th>收款人</th>
                <th>到账金额</th>
                <th>出款状态</th>
                <th>回单</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((o) => (
                <tr
                  key={o.id}
                  className={
                    order?.id === o.id && page === "workbench" ? "selected" : ""
                  }
                >
                  <td>
                    <button
                      className="order-link"
                      title={o.id}
                      onClick={() => {
                        setSelected(o.id);
                        if (page !== "workbench") go("detail");
                      }}
                    >
                      <strong>{shortId(o.id)}</strong>
                    </button>
                    <small>
                      {o.quote.sourceCurrency} · {o.quote.configVersion}
                    </small>
                  </td>
                  <td>
                    {beneficiaries.find((b) => b.id === o.quote.beneficiaryId)
                      ?.name ?? shortId(o.quote.beneficiaryId)}
                  </td>
                  <td className="numeric">
                    {symbol(o.quote.payoutCurrency)}
                    {money(o.quote.payoutAmount)}
                    <small>{o.quote.payoutCurrency}</small>
                  </td>
                  <td>
                    <Badge status={o.payoutStatus} />
                    {o.depositStatus === "exception" && (
                      <small className="red">入金异常</small>
                    )}
                  </td>
                  <td>
                    <Badge status={o.receiptStatus}>
                      {o.receiptStatus === "none" ? "待补充" : "已登记回单"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!visible.length && (
            <Empty title={search ? "没有匹配的订单" : "还没有订单"}>
              {role === "customer"
                ? "创建付款后，服务端订单将在这里显示。"
                : "可以先创建 MOCK 场景，由同一管理员验证完整流程。"}
            </Empty>
          )}
        </div>
      </div>
    );
  }
  async function uploadReceipt(orderId: string, file: File) {
    if (busyRef.current) return;
    if (
      file.size > 2 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "application/pdf"].includes(file.type)
    ) {
      setError(
        "请选择不超过 2 MB 的 PNG、JPEG 或 PDF 演示回单；较大截图请压缩后上传。",
      );
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      await mutate(
        `orders/${orderId}/receipt-file`,
        {
          fileName: file.name,
          contentType: file.type,
          dataBase64: btoa(binary),
        },
        "回单已上传，客户可在订单详情下载。付款状态不受影响。",
      );
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function downloadReceipt(orderId: string) {
    try {
      const file = await request<{
        fileName: string;
        contentType: string;
        dataBase64: string;
      }>(`orders/${orderId}/receipt-file`);
      const binary = atob(file.dataBase64);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/octet-stream" }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = file.fileName;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(errorText(e));
    }
  }
  function fundingPanel(o: Order) {
    const funding = o.fundingInstruction;
    return (
      <>
        <div className="deposit-number">
          {money(funding?.amount ?? o.quote.totalDeposit)}{" "}
          <span>{o.quote.sourceCurrency}</span>
        </div>
        <dl className="details">
          <div>
            <dt>入金网络</dt>
            <dd>{funding?.network ?? "MOCK"} · 演示网络</dd>
          </div>
          <div>
            <dt>入金指引</dt>
            <dd>未接入托管服务 · 不可转账</dd>
          </div>
          <div>
            <dt>到账状态</dt>
            <dd>
              <Badge status={o.depositStatus} />
            </dd>
          </div>
          {(funding?.expiresAt ?? o.fundingExpiresAt) && (
            <div>
              <dt>演示入金截止</dt>
              <dd>{date((funding?.expiresAt ?? o.fundingExpiresAt)!)}</dd>
            </div>
          )}
        </dl>
        <div className="demo-address">
          <Lock size={19} />
          <strong>MOCK ONLY · 无可付款地址或二维码</strong>
        </div>
        <Note>
          当前未接入真实托管收币服务，请勿转账。正式接入后，这里会显示与订单绑定的地址、网络及所需金额。演示仅由管理员模拟到账。
        </Note>
      </>
    );
  }
  function orderDetail(admin = false) {
    if (!order)
      return (
        <div className="card">
          <Empty title="选择一笔订单查看详情" />
        </div>
      );
    const o = order;
    const b = beneficiaries.find((x) => x.id === o.quote.beneficiaryId);
    const attempt = data?.attempts?.filter((a) => a.orderId === o.id).at(-1);
    const refunds = data?.refunds?.filter((r) => r.orderId === o.id) ?? [];
    const blockedByRefund = refunds.some((r) => r.kind === "principal");
    return (
      <div className="card order-detail">
        <div className="card-heading">
          <h2>订单 {shortId(o.id)}</h2>
          <Badge>
            <Lock size={13} /> 报价快照已锁定
          </Badge>
        </div>
        <p className="record-id">{o.id}</p>
        <div className="summary-grid">
          <div>
            <small>收款人</small>
            <strong>{b?.name ?? shortId(o.quote.beneficiaryId)}</strong>
            <span>
              {b?.accountMasked} · {o.quote.payoutCurrency}
            </span>
          </div>
          <div>
            <small>目标出款金额</small>
            <strong className="large-number">
              {symbol(o.quote.payoutCurrency)}
              {money(o.quote.payoutAmount)}
            </strong>
            <span>{o.quote.payoutCurrency}</span>
          </div>
        </div>
        <div className="status-grid">
          <div>
            <small>稳定币入金</small>
            <Badge status={o.depositStatus} />
          </div>
          <div>
            <small>外部换汇</small>
            <Badge status={o.conversionStatus} />
          </div>
          <div>
            <small>法币出款</small>
            <Badge status={o.payoutStatus} />
          </div>
          <div>
            <small>对账</small>
            <Badge status={o.reconciled ? "verified" : "pending"}>
              {o.reconciled ? "已核对一致" : "待核对"}
            </Badge>
          </div>
        </div>
        {o.depositStatus === "exception" && (
          <Note danger>
            入金进入异常队列。服务端阻止自动兑换与出款，须独立调查。
          </Note>
        )}
        <FeeRows quote={o.quote} />
        {!admin && o.depositStatus === "awaiting" && fundingPanel(o)}
        <dl className="details">
          <div>
            <dt>金额输入方式</dt>
            <dd>
              {o.quote.amountMode === "target_payout"
                ? "目标出款金额"
                : o.quote.amountMode === "total_deposit"
                  ? "支付总额（含费用）"
                  : "兑换本金（费用另加）"}
            </dd>
          </div>
          <div>
            <dt>报价配置版本</dt>
            <dd>{o.quote.configVersion}</dd>
          </div>
          <div>
            <dt>入金网络</dt>
            <dd>MOCK · 无真实充值地址</dd>
          </div>
        </dl>
        <div className="ruleline" />
        {admin ? (
          <>
            <div className="card-heading">
              <h3>人工出款流程</h3>
              <Badge>{actors.find(([a]) => a === actor)?.[1]}</Badge>
            </div>
            <Steps
              active={
                o.payoutStatus === "sent"
                  ? 3
                  : o.depositStatus === "confirmed"
                    ? 2
                    : 1
              }
              labels={["确认入金", "线下付款", "确认与回单"]}
            />
            <Note>
              一个管理员即可处理。在线下 OTC
              或银行完成付款后，登记结果；回单可稍后上传。这里所有订单与资金均为
              MOCK 演示。
            </Note>
            <div className="actions">
              {o.depositStatus === "awaiting" && (
                <button
                  className="button"
                  disabled={locked}
                  onClick={() =>
                    openCommand({
                      title: "模拟稳定币到账",
                      description: "仅创建签名 MOCK 入金事件，不产生真实转账。",
                      path: `demo/orders/${o.id}/deposit`,
                      button: "模拟到账",
                      success: "模拟入金已处理。",
                    })
                  }
                >
                  模拟到账
                </button>
              )}
              {o.depositStatus === "confirmed" &&
                ["draft", "failed", "approved", "awaiting_approval"].includes(
                  o.payoutStatus,
                ) &&
                !blockedByRefund && (
                  <>
                    <button
                      className="button"
                      disabled={locked}
                      onClick={() =>
                        openCommand({
                          title: "确认已付款",
                          description:
                            "请核对收款人和金额。此操作登记线下已完成的付款，不会发起转账。回单可以稍后补充。",
                          path: `orders/${o.id}/manual-payout`,
                          base: {
                            idempotencyKey:
                              "manual_" + o.id + "_" + (attempt?.id ?? "first"),
                            outcome: "sent",
                          },
                          fields: [
                            {
                              key: "actualAmount",
                              label:
                                "实际付款金额（" +
                                o.quote.payoutCurrency +
                                "）",
                              value: o.quote.payoutAmount,
                            },
                            {
                              key: "paidAt",
                              label: "付款时间（ISO，含时区）",
                              value: new Date().toISOString(),
                            },
                            reference(""),
                            evidence(""),
                          ],
                          button: "确认付款记录",
                          success: "付款结果已登记，可上传回单或稍后补充。",
                        })
                      }
                    >
                      确认已付款
                    </button>
                    <button
                      className="button outline"
                      disabled={locked}
                      onClick={() =>
                        openCommand({
                          title: "标记付款结果待核实",
                          description:
                            "若渠道超时或不能确定是否已付款，请先标记待核实。系统会阻止重复付款和退款。",
                          path: `orders/${o.id}/manual-payout`,
                          base: {
                            idempotencyKey:
                              "unknown_" +
                              o.id +
                              "_" +
                              (attempt?.id ?? "first"),
                            outcome: "unknown",
                          },
                          fields: [evidence("")],
                          button: "标记待核实",
                          success: "已锁定重复付款，请先核实渠道结果。",
                        })
                      }
                    >
                      结果待核实
                    </button>
                  </>
                )}
              {attempt?.state === "unknown" && (
                <>
                  <button
                    className="button"
                    disabled={locked}
                    onClick={() =>
                      openCommand({
                        title: "核实已付款",
                        description:
                          "根据渠道查询结果登记参考号及证据，再核对实际金额。",
                        path: `attempts/${attempt.id}/resolve`,
                        base: { outcome: "sent" },
                        fields: [
                          {
                            key: "actualAmount",
                            label:
                              "实际付款金额（" + o.quote.payoutCurrency + "）",
                            value: o.quote.payoutAmount,
                          },
                          {
                            key: "paidAt",
                            label: "付款时间（ISO，含时区）",
                            value: new Date().toISOString(),
                          },
                          reference(""),
                          evidence(""),
                        ],
                        button: "确认查询结果",
                        success: "付款结果已核实，请核对渠道金额。",
                      })
                    }
                  >
                    核实已付款
                  </button>
                  <button
                    className="button outline"
                    disabled={locked}
                    onClick={() =>
                      openCommand({
                        title: "核实未付款",
                        description: "仅在渠道明确确认未发生付款时解除锁定。",
                        path: `attempts/${attempt.id}/resolve`,
                        base: { outcome: "failed" },
                        fields: [evidence("")],
                        button: "确认未付款",
                        success: "已核实未付款，可以重新处理。",
                      })
                    }
                  >
                    核实未付款
                  </button>
                </>
              )}
              {o.payoutStatus === "sent" && !o.reconciled && (
                <button
                  className="button outline"
                  disabled={locked}
                  onClick={() =>
                    openCommand({
                      title: "核对付款记录",
                      description:
                        "核对实际金额和渠道参考号。不一致会进入差异队列。",
                      path: `orders/${o.id}/reconcile`,
                      fields: [
                        reference(attempt?.providerReference ?? ""),
                        {
                          key: "actualAmount",
                          label: "实际金额（" + o.quote.payoutCurrency + "）",
                          value: o.quote.payoutAmount,
                        },
                        evidence(""),
                      ],
                      button: "确认核对",
                      success: "核对结果已保存。",
                    })
                  }
                >
                  核对付款记录
                </button>
              )}
            </div>
            {o.payoutStatus === "sent" && (
              <p className="success-text">
                <CheckCircle size={18} />
                {o.reconciled
                  ? "付款已登记，金额已核对"
                  : "付款已登记，待核对金额"}
              </p>
            )}
            <p className="muted small">
              系统保留操作记录、金额校验与防重复处理。无需切换经办或复核人员。
            </p>
          </>
        ) : (
          <div className="actions">
            <button
              className="button outline"
              disabled={busy}
              onClick={() => void reload()}
            >
              <ArrowsClockwise size={17} />
              刷新服务端状态
            </button>
            <button
              className="button text"
              disabled={busy}
              onClick={() => {
                changeActor("admin-demo");
                setSelected(o.id);
              }}
            >
              查看管理演示 <ArrowUpRight size={16} />
            </button>
          </div>
        )}
        {o.payoutStatus === "unknown" && (
          <Note danger>
            出款结果未知。禁止重复出款与退款，须先核实渠道查询结果。
          </Note>
        )}
        <div className="receipt-row">
          <FileText size={30} />
          <div>
            <strong>付款截图 / 银行水单</strong>
            <p>
              {o.receiptStatus === "none"
                ? "付款确认后可上传，也可稍后补充"
                : o.receiptFileAvailable
                  ? "回单文件已上传，可下载查看"
                  : "仅有回单记录，文件待管理员补充"}
            </p>
          </div>
          {admin && (
            <label className="button outline">
              <Upload size={16} />
              上传回单
              <input
                type="file"
                accept="image/png,image/jpeg,application/pdf"
                disabled={locked || o.payoutStatus !== "sent"}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void uploadReceipt(o.id, file);
                }}
              />
            </label>
          )}
          {o.receiptFileAvailable && (
            <button
              className="button outline"
              disabled={locked}
              onClick={() => void downloadReceipt(o.id)}
            >
              <Download size={16} />
              下载回单
            </button>
          )}
        </div>
        <p className="muted small">
          演示上传仅支持 PNG、JPEG、PDF，最大 64
          KB。仅使用虚构文件；文件未经安全扫描，演示会话失效后不可恢复。
        </p>
        <div className="ruleline" />
        <div className="card-heading">
          <h3>退款记录</h3>
          {maker &&
            o.depositStatus === "confirmed" &&
            ((o.conversionStatus === "pending" &&
              ["draft", "cancelled"].includes(o.payoutStatus)) ||
              o.payoutStatus === "sent") && (
              <button
                className="button outline"
                disabled={locked}
                onClick={() =>
                  openCommand({
                    title:
                      o.payoutStatus === "sent"
                        ? "申请服务费退款记录"
                        : "申请换汇前本金退款",
                    description:
                      "仅创建 MOCK 退款预留记录，须再次确认并登记结果。服务端校验累计金额上限，不执行实际退款。",
                    path: `orders/${o.id}/refunds`,
                    base: {
                      idempotencyKey: "refund_" + uid(),
                      kind:
                        o.payoutStatus === "sent" ? "service_fee" : "principal",
                    },
                    fields: [
                      {
                        key: "amount",
                        label: "退款金额（" + o.quote.sourceCurrency + "）",
                        value: "1.000000",
                      },
                    ],
                    button: "提交退款预留",
                    success: "退款申请已预留，等待管理员确认。",
                  })
                }
              >
                申请模拟退款
              </button>
            )}
        </div>
        {!refunds.length ? (
          <p className="muted small">尚无退款申请。</p>
        ) : (
          refunds.map((r) => (
            <div className="refund-row" key={r.id}>
              <div>
                <strong>
                  {r.kind === "principal" ? "本金退款" : "服务费退款"} ·{" "}
                  {money(r.amount)} {r.currency}
                </strong>
                <small>{shortId(r.id)}</small>
              </div>
              <Badge status={r.status} />
              {finance && r.status === "requested" && (
                <button
                  className="button outline"
                  disabled={locked}
                  onClick={() =>
                    void mutate(
                      `refunds/${r.id}/approve`,
                      {},
                      "退款已确认，请登记结果。",
                    )
                  }
                >
                  审批退款
                </button>
              )}
              {maker && r.status === "approved" && (
                <button
                  className="button outline"
                  disabled={locked}
                  onClick={() =>
                    openCommand({
                      title: "登记模拟退款结果",
                      description:
                        "保存外部 MOCK 退款参考号与证据。退款对佣金的影响由服务端生成负向调整，不改写原记录。",
                      path: `refunds/${r.id}/record`,
                      fields: [
                        reference("refund_" + r.id),
                        evidence(
                          "MOCK: external refund independently recorded",
                        ),
                      ],
                      button: "登记 MOCK 退款",
                      success: "模拟退款已登记，相关佣金调整由服务端计算。",
                    })
                  }
                >
                  登记退款
                </button>
              )}
            </div>
          ))
        )}
      </div>
    );
  }
  function pricingPanel() {
    const p = data?.pricingFixture,
      route = p?.routes[pricingMarket];
    return (
      <div className="card pricing-panel">
        <div className="card-heading">
          <h2>汇率与费率</h2>
          <Badge>只读样例配置</Badge>
        </div>
        {!p || !route ? (
          <Empty title="当前身份无定价配置视图" />
        ) : (
          <>
            <label>
              适用市场
              <select
                value={pricingMarket}
                onChange={(e) => setPricingMarket(e.target.value)}
              >
                {Object.keys(p.routes).map((currency) => (
                  <option key={currency}>{currency}</option>
                ))}
              </select>
            </label>
            <dl className="details">
              <div>
                <dt>客户汇率</dt>
                <dd>{route.customerRate}</dd>
              </div>
              <div>
                <dt>参考汇率</dt>
                <dd>{route.referenceRate}</dd>
              </div>
              <div>
                <dt>成本汇率</dt>
                <dd>{route.costRate}</dd>
              </div>
              <div className="divided">
                <dt>默认服务费</dt>
                <dd>{money(p.serviceFee)} 稳定币</dd>
              </div>
              <div>
                <dt>渠道费</dt>
                <dd>{money(p.channelFee)} 稳定币</dd>
              </div>
              <div>
                <dt>配置版本</dt>
                <dd>{p.version}</dd>
              </div>
            </dl>
            <Note>
              <Lock size={15} />{" "}
              订单保留原报价快照。客户级服务费覆盖以实际服务器报价为准。
            </Note>
          </>
        )}
        <p className="muted small">
          费率发布接口尚未实现。本面板只展示服务端配置，不提供保存或发布按钮。
        </p>
      </div>
    );
  }
  function settlementsTable() {
    return (
      <>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>结算单</th>
                <th>月份</th>
                <th>金额</th>
                <th>状态</th>
                {role === "admin" && <th>操作</th>}
              </tr>
            </thead>
            <tbody>
              {settlementRows.map((s) => (
                <tr key={s.id}>
                  <td title={s.id}>{shortId(s.id)}</td>
                  <td>{s.month}</td>
                  <td className="numeric">
                    {money(s.amount)} {s.currency}
                  </td>
                  <td>
                    <Badge status={s.status}>
                      {s.status === "approved"
                        ? "已批准 · 未付款"
                        : s.status === "draft"
                          ? "结算草稿"
                          : "已取消"}
                    </Badge>
                  </td>
                  {role === "admin" && (
                    <td>
                      {finance && s.status === "draft" && (
                        <div className="actions table-actions">
                          <button
                            className="button outline"
                            disabled={locked}
                            onClick={() =>
                              void mutate(
                                `settlements/${s.id}/approve`,
                                {},
                                "结算单已批准。本系统不执行或记录实际佣金付款。",
                              )
                            }
                          >
                            批准
                          </button>
                          <button
                            className="button text"
                            disabled={locked}
                            onClick={() =>
                              openCommand({
                                title: "取消结算草稿",
                                description:
                                  "取消未批准的草稿并释放分配，之后可以使用服务端最新佣金重新生成。",
                                path: `settlements/${s.id}/cancel`,
                                fields: [
                                  {
                                    key: "reason",
                                    label: "取消原因",
                                    value:
                                      "MOCK: rebuild with latest eligible commissions",
                                    type: "textarea",
                                  },
                                ],
                                button: "取消草稿",
                                success: "结算草稿已取消，佣金分配已释放。",
                              })
                            }
                          >
                            取消草稿
                          </button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!settlementRows.length && (
          <Empty title="尚无结算单">
            管理员可为已关闭月份的合格佣金生成草稿。伙伴只读查看。
          </Empty>
        )}
        <Note>
          “已批准”不代表佣金已支付。当前 API
          没有实际佣金付款功能，也不会在浏览器中模拟“已付款”。
        </Note>
      </>
    );
  }
  function commissionTable() {
    return (
      <>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{role === "partner" ? "客户别名" : "佣金记录"}</th>
                <th>可佣服务费</th>
                <th>比例快照</th>
                <th>佣金</th>
                <th>资格</th>
              </tr>
            </thead>
            <tbody>
              {commissionRows.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.customerAlias ?? shortId(c.id)}
                    <small>
                      {c.state === "adjustment" ? "退款负向调整" : "已对账订单"}
                    </small>
                  </td>
                  <td className="numeric">
                    {money(c.base)} {c.currency}
                  </td>
                  <td>{percentage(c.rate)}</td>
                  <td className="numeric">
                    {money(c.value)} {c.currency}
                  </td>
                  <td>
                    <Badge status={c.eligibility ?? c.state} />
                    <small>
                      {c.eligibility === "hold" ? "最早 " : ""}
                      {date(c.eligibleAt)}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!commissionRows.length && (
          <Empty title="尚无佣金记录">
            关联订单发送并通过对账后，才会由服务端按规则计提。
          </Empty>
        )}
        <Note>
          本金与通道费不参与计佣。观察期、负向调整、分配冻结和月份资格均由服务端判定；比例是样例规则，不代表正式合作条款。
        </Note>
      </>
    );
  }
  const title =
    page === "payment"
      ? step === 2
        ? "确认付款"
        : step === 3
          ? "等待稳定币到账"
          : "创建付款"
      : page === "certification" && role === "admin"
        ? "客户审核"
        : page === "recipients" && role === "admin"
          ? "收款人白名单"
          : titles[page];
  const storageLabel =
    health?.persistence === "session-memory"
      ? "会话内存 · 最多30分钟/实例重启失效 · 勿输入真实资料"
      : health?.persistence === "memory"
        ? "内存模式 · 重启 API 后清空"
        : health?.persistence === "postgres"
          ? "PostgreSQL · 服务端持久化"
          : health
            ? health.persistence + " · 服务端存储"
            : "存储状态待确认";
  const visibleBatch =
    batch && data?.batches?.some((b) => b.id === batch.batch.id)
      ? {
          batch: batch.batch,
          items:
            data.batchItems?.filter((i) => i.batchId === batch.batch.id) ?? [],
        }
      : batch;
  return (
    <div className="app">
      <aside className="sidebar">
        <button className="brand" onClick={() => go(navs[role][0][0])}>
          <img src="/brand-mark.png" alt="" />
          <span>
            汇途<small>HUITU</small>
          </span>
        </button>
        <div className="sidebar-label">
          {role === "admin"
            ? "管理后台"
            : role === "partner"
              ? "合作伙伴"
              : "支付工作台"}
        </div>
        <nav aria-label="主导航">
          {navs[role].map(([p, label, I]) => (
            <button
              key={p}
              title={label}
              className={
                page === p || (p === "orders" && page === "detail")
                  ? "active"
                  : ""
              }
              onClick={() => go(p)}
            >
              <I size={20} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => setSupport((v) => !v)}>
            <Question size={21} />
            帮助与支持
          </button>
          <p>安全、清晰的每一笔付款</p>
          <span className="tiny">汇途 · MOCK 验证空间</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>
              {role === "admin"
                ? "管理后台"
                : role === "partner"
                  ? "合作伙伴"
                  : "付款"}
            </span>
            <b>/</b>
            {title}
          </div>
          <div className="top-actions">
            <span className="demo-badge">MOCK · 无真实资金</span>
            <select
              aria-label="演示角色切换"
              value={actor}
              disabled={busy}
              onChange={(e) => changeActor(e.target.value as ActorKey)}
            >
              {actors.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button
              className="avatar"
              aria-label="刷新服务器数据"
              disabled={busy}
              onClick={() => void reload()}
            >
              <ArrowsClockwise size={18} />
            </button>
          </div>
        </header>
        <main>
          <div className="connection-strip" role="status">
            <span className={"connection-dot " + connection} />
            <span>
              {connection === "connected"
                ? "已连接 MOCK API"
                : connection === "loading"
                  ? "正在连接 MOCK API…"
                  : "后端连接不可用"}
            </span>
            <span className="storage-status">
              <Database size={13} />
              {storageLabel}
            </span>
            <span className="connection-right">演示身份，无真实认证</span>
          </div>
          {health?.persistence === "session-memory" && (
            <div className="session-warning" role="note">
              <Lock size={17} />
              <span>
                <strong>隔离会话演示 · 请勿输入真实资料</strong>会话数据最多保留
                30
                分钟，实例重启即失效。不要输入真实身份、银行账户、钱包或其他敏感信息。
              </span>
            </div>
          )}
          <div className="page-heading">
            <div>
              <h1>{title}</h1>
              <p>{subtitles[page]}</p>
            </div>
            {page === "payment" && step === 1 ? (
              <div className="segmented">
                <button
                  disabled={busy}
                  className={actor === "customer-demo" ? "active" : ""}
                  onClick={() => changeActor("customer-demo")}
                >
                  个人
                </button>
                <button
                  disabled={busy}
                  className={actor === "company-demo" ? "active" : ""}
                  onClick={() => changeActor("company-demo")}
                >
                  企业
                </button>
              </div>
            ) : (
              <span className="date">SERVER-BACKED DEMO</span>
            )}
          </div>
          {support && (
            <div className="card support">
              <h2>从这里开始体验</h2>
              <p>
                客户：输入目标法币金额或稳定币总额 → 核对报价 →
                创建订单与查看入金指引。管理员：确认入金 → 线下付款后确认 →
                上传回单 → 核对记录。伙伴：查看同一服务端产生的佣金与观察期。
              </p>
              <Note>
                只使用虚构资料。所有资金相关按钮仅调用 MOCK
                后端；不支持真实充值、换汇或付款。内存模式在 API
                重启后清空；会话内存最多保留 30
                分钟，实例重启也会失效。实际存储模式见页面连接状态。
              </Note>
              <button className="button text" onClick={() => setSupport(false)}>
                收起说明
              </button>
            </div>
          )}
          {error && (
            <div className="api-error" role="alert">
              <WarningCircle size={20} />
              <div>
                <strong>
                  {connection === "error" ? "无法读取后端数据" : "请求未完成"}
                </strong>
                <p>{error}</p>
              </div>
              <button
                className="button outline"
                disabled={busy}
                onClick={() => void reload()}
              >
                重新读取
              </button>
            </div>
          )}
          {!data ? (
            <div className="card">
              <Empty
                title={
                  connection === "loading"
                    ? "正在读取服务端数据"
                    : "没有可用的服务器数据"
                }
              >
                {connection === "loading"
                  ? "正在检查后端连接与当前身份的数据范围。"
                  : "请检查演示后端连接是否可用。这里不会用静态样例替代失败的请求。"}
              </Empty>
            </div>
          ) : (
            <>
              {page === "payment" && role === "customer" && (
                <>
                  <Steps active={step} />
                  {step === 1 ? (
                    <div className="payment-layout">
                      <section className="payment-form">
                        <div className="tabs light">
                          <button
                            className={mode === "single" ? "active" : ""}
                            onClick={() => setMode("single")}
                          >
                            单笔付款
                          </button>
                          <button
                            className={mode === "batch" ? "active" : ""}
                            onClick={() => setMode("batch")}
                          >
                            批量付款
                          </button>
                          <button
                            className="end"
                            onClick={() => setMode("batch")}
                          >
                            <Upload size={17} />
                            导入表格
                          </button>
                        </div>
                        {mode === "single" ? (
                          <>
                            <h2>付款信息</h2>
                            <div
                              className="amount-mode"
                              role="group"
                              aria-label="金额输入方式"
                            >
                              <button
                                type="button"
                                disabled={busy}
                                aria-pressed={amountMode === "target_payout"}
                                className={
                                  amountMode === "target_payout" ? "active" : ""
                                }
                                onClick={() =>
                                  editForm(() => setAmountMode("target_payout"))
                                }
                              >
                                目标出款金额
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                aria-pressed={amountMode === "total_deposit"}
                                className={
                                  amountMode === "total_deposit" ? "active" : ""
                                }
                                onClick={() =>
                                  editForm(() => setAmountMode("total_deposit"))
                                }
                              >
                                支付总额（含费用）
                              </button>
                            </div>
                            <label>
                              {amountMode === "total_deposit"
                                ? "支付总额（含费用）"
                                : "目标出款金额"}
                              <div className="input-unit amount">
                                <input
                                  aria-label={
                                    amountMode === "total_deposit"
                                      ? "支付总额（含费用）"
                                      : "目标出款金额"
                                  }
                                  inputMode="decimal"
                                  placeholder={
                                    amountMode === "target_payout"
                                      ? market === "CNY"
                                        ? "例如 100000 人民币"
                                        : "例如 50000 美元"
                                      : "例如 1000 USDT"
                                  }
                                  value={enteredAmount}
                                  disabled={busy}
                                  onChange={(e) =>
                                    editForm(() =>
                                      setEnteredAmount(e.target.value),
                                    )
                                  }
                                />
                                <select
                                  aria-label={
                                    amountMode === "target_payout"
                                      ? "出款币种"
                                      : "稳定币"
                                  }
                                  value={
                                    amountMode === "target_payout"
                                      ? market
                                      : asset
                                  }
                                  disabled={busy}
                                  onChange={(e) =>
                                    editForm(() =>
                                      amountMode === "target_payout"
                                        ? setMarket(e.target.value)
                                        : setAsset(e.target.value),
                                    )
                                  }
                                >
                                  {amountMode === "target_payout" ? (
                                    <>
                                      <option>CNY</option>
                                      <option>USD</option>
                                    </>
                                  ) : (
                                    <>
                                      <option>USDT</option>
                                      <option>USDC</option>
                                    </>
                                  )}
                                </select>
                              </div>
                            </label>
                            <div className="form-grid">
                              <label>
                                支付稳定币
                                <select
                                  aria-label="支付稳定币"
                                  value={asset}
                                  disabled={busy}
                                  onChange={(e) =>
                                    editForm(() => setAsset(e.target.value))
                                  }
                                >
                                  <option>USDT</option>
                                  <option>USDC</option>
                                </select>
                              </label>
                              <label>
                                网络
                                <select aria-label="网络" value="MOCK" disabled>
                                  <option>MOCK · 模拟网络</option>
                                </select>
                              </label>
                              <label>
                                收款地区
                                <select
                                  aria-label="收款地区"
                                  value={market}
                                  disabled={busy}
                                  onChange={(e) =>
                                    editForm(() => {
                                      setMarket(e.target.value);
                                      setBeneficiaryId("");
                                    })
                                  }
                                >
                                  <option value="CNY">中国大陆 · CNY</option>
                                  <option value="USD">美国 · USD</option>
                                </select>
                              </label>
                            </div>
                            <div className="card-heading recipient-heading">
                              <h2>收款人</h2>
                              <button
                                className="link"
                                onClick={() => go("recipients")}
                              >
                                管理白名单
                              </button>
                            </div>
                            <div className="recipient-select">
                              <div className="person-mark">示</div>
                              <div>
                                <select
                                  aria-label="选择收款人"
                                  value={chosenBeneficiaryId}
                                  disabled={
                                    !approvedBeneficiaries.length || busy
                                  }
                                  onChange={(e) =>
                                    editForm(() =>
                                      setBeneficiaryId(e.target.value),
                                    )
                                  }
                                >
                                  {!approvedBeneficiaries.length && (
                                    <option value="">暂无已审核收款人</option>
                                  )}
                                  {approvedBeneficiaries.map((b) => (
                                    <option key={b.id} value={b.id}>
                                      {b.name}
                                    </option>
                                  ))}
                                </select>
                                <p>
                                  {recipient
                                    ? recipient.accountMasked +
                                      " · " +
                                      recipient.currency
                                    : "请先新增并由管理员审核白名单"}
                                </p>
                              </div>
                              <ShieldCheck size={22} className="teal" />
                            </div>
                            <div className="purpose">
                              <Note>
                                {amountMode === "total_deposit"
                                  ? "支付总额已包含服务费与通道费，扣除费用后的本金用于兑换。"
                                  : "输入希望支付的法币金额，服务端反算应转入的稳定币总额（含费用）。收款银行如另收费，以实际渠道规则为准。"}
                              </Note>
                            </div>
                            <p className="subtle">
                              <Info size={16} />
                              报价、费用与到账金额均由服务端计算
                            </p>
                            <div className="bottom-note">
                              <FileText size={20} />
                              付款截图或水单可后补，不阻塞订单付款
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="card-heading">
                              <h2>批量付款</h2>
                              <button
                                className="link"
                                onClick={() =>
                                  downloadCSV(
                                    "汇途-MOCK批量模板.csv",
                                    template()
                                      .split("\n")
                                      .map((line) => line.split(",")),
                                  )
                                }
                              >
                                <Download size={17} />
                                下载模板
                              </button>
                            </div>
                            <Note>
                              批量 CSV 的 sourceAmount
                              始终表示兑换本金，费用另加。 CSV 将提交给隔离 MOCK
                              API 校验与保存。仅导入虚构资料；最多 100
                              行、100KB，使用当前客户的白名单 ID。
                            </Note>
                            <div className="upload-zone">
                              <Upload size={28} />
                              <strong>导入 CSV 演示文件</strong>
                              <span>每行独立验证 · UTF-8 编码</span>
                              <label className="button outline file-label">
                                选择 CSV
                                <input
                                  type="file"
                                  accept=".csv,text/csv"
                                  aria-label="导入 CSV"
                                  disabled={busy}
                                  onChange={async (e) => {
                                    const f = e.target.files?.[0];
                                    if (!f) return;
                                    if (f.size > 100000) {
                                      setError("文件请小于 100KB");
                                      return;
                                    }
                                    setBatchText(await f.text());
                                    setBatch(null);
                                    setBatchKey("");
                                    setToast(
                                      "CSV 已在浏览器读取，点击下方按钮提交服务端校验。",
                                    );
                                    e.target.value = "";
                                  }}
                                />
                              </label>
                            </div>
                            <label>
                              演示 CSV
                              <textarea
                                aria-label="演示 CSV"
                                value={batchText}
                                rows={6}
                                spellCheck={false}
                                disabled={busy}
                                placeholder="clientItemId,beneficiaryId,sourceCurrency,sourceAmount"
                                onChange={(e) => {
                                  setBatchText(e.target.value);
                                  setBatch(null);
                                  setBatchKey("");
                                }}
                              />
                            </label>
                            <div className="actions">
                              <button
                                className="button"
                                disabled={
                                  locked || !batchText.trim() || !!batch
                                }
                                onClick={() => void importBatch()}
                              >
                                提交服务端校验
                              </button>
                              <button
                                className="button text"
                                disabled={busy}
                                onClick={() => {
                                  setBatchText(template(true));
                                  setBatch(null);
                                  setBatchKey("");
                                }}
                              >
                                载入含错误样例
                              </button>
                            </div>
                            {visibleBatch && (
                              <div className="batch-results">
                                <h3>
                                  逐行校验 ·{" "}
                                  {
                                    visibleBatch.items.filter(
                                      (i) => i.status === "valid",
                                    ).length
                                  }{" "}
                                  笔可提交
                                </h3>
                                {visibleBatch.items.map((item, i) => (
                                  <div className="batch-row" key={item.id}>
                                    <span
                                      className={
                                        "line-number " +
                                        (item.status === "error" ? "error" : "")
                                      }
                                    >
                                      {i + 1}
                                    </span>
                                    <div>
                                      <strong>
                                        {item.clientItemId || "缺少参考号"}
                                      </strong>
                                      <small>
                                        {item.errors.join("；") ||
                                          (item.orderId
                                            ? "订单 " + shortId(item.orderId)
                                            : money(item.sourceAmount) +
                                              " " +
                                              item.sourceCurrency +
                                              " 本金")}
                                      </small>
                                    </div>
                                    <Badge status={item.status} />
                                  </div>
                                ))}
                                <div className="actions">
                                  <button
                                    className="button"
                                    disabled={
                                      locked ||
                                      !visibleBatch.items.some(
                                        (i) => i.status === "valid",
                                      )
                                    }
                                    onClick={() => void submitBatch()}
                                  >
                                    仅提交校验通过的行
                                  </button>
                                  <button
                                    className="button outline"
                                    onClick={() =>
                                      downloadCSV("汇途-批次逐行结果.csv", [
                                        [
                                          "clientItemId",
                                          "status",
                                          "errors",
                                          "orderId",
                                        ],
                                        ...visibleBatch.items.map((i) => [
                                          i.clientItemId,
                                          i.status,
                                          i.errors.join("; "),
                                          i.orderId ?? "",
                                        ]),
                                      ])
                                    }
                                  >
                                    下载逐行结果
                                  </button>
                                </div>
                                <p className="muted small">
                                  提交时由服务端创建报价和订单，重复提交不会重复生成订单。
                                </p>
                              </div>
                            )}
                            {!!data.batches?.length && (
                              <div className="batch-history">
                                <h3>服务端批次记录</h3>
                                {data.batches.map((b) => (
                                  <button
                                    className="batch-history-row"
                                    key={b.id}
                                    onClick={() =>
                                      setBatch({
                                        batch: b,
                                        items:
                                          data.batchItems?.filter(
                                            (i) => i.batchId === b.id,
                                          ) ?? [],
                                      })
                                    }
                                  >
                                    <Files size={18} />
                                    <span>{b.clientBatchId}</span>
                                    <ArrowRight size={16} />
                                  </button>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </section>
                      <aside className="quote-panel">
                        <div className="card-heading">
                          <h2>
                            {mode === "batch" ? "批量付款说明" : "本次报价"}
                          </h2>
                          <span className="small muted">
                            {quote && mode === "single" ? (
                              <>
                                <Clock size={13} />{" "}
                                <b className="teal">
                                  {String(Math.floor(remaining / 60)).padStart(
                                    2,
                                    "0",
                                  )}
                                  :{String(remaining % 60).padStart(2, "0")}
                                </b>
                              </>
                            ) : (
                              "服务端快照"
                            )}
                          </span>
                        </div>
                        {mode === "single" ? (
                          <>
                            <p className="quote-label">收款人预计到账</p>
                            <div className="quote-amount">
                              {quote
                                ? symbol(quote.payoutCurrency) +
                                  money(quote.payoutAmount)
                                : "—"}
                              <span>{market}</span>
                            </div>
                            <div className="ruleline" />
                            {quote ? (
                              <FeeRows quote={quote} />
                            ) : (
                              <div className="quote-placeholder">
                                <p>
                                  {quoteBusy
                                    ? "正在获取服务器报价…"
                                    : "填写金额并选择可用收款人"}
                                </p>
                                <p>费用与汇率确认后将在这里列明。</p>
                              </div>
                            )}
                            {quoteError && <Note danger>{quoteError}</Note>}
                            <p className="subtle">
                              <Info size={16} />
                              {amountMode === "total_deposit"
                                ? "费用已包含在支付总额内"
                                : "已按目标法币金额反算稳定币总额"}
                            </p>
                            <button
                              className="button full big"
                              disabled={
                                locked ||
                                quoteBusy ||
                                !quote ||
                                remaining === 0 ||
                                currentCustomer?.status !== "approved"
                              }
                              onClick={() => {
                                setStep(2);
                                setChecked(false);
                                window.scrollTo(0, 0);
                              }}
                            >
                              下一步，确认付款 <ArrowRight size={20} />
                            </button>
                            {quote && remaining === 0 && (
                              <button
                                className="button outline full"
                                onClick={() => setQuoteVersion((v) => v + 1)}
                              >
                                报价过期，重新获取
                              </button>
                            )}
                            {quoteError && (
                              <button
                                className="button text full"
                                onClick={() => setQuoteVersion((v) => v + 1)}
                              >
                                重试报价
                              </button>
                            )}
                            <p className="center muted small">
                              确认报价后创建订单，超时需重新报价
                            </p>
                            {currentCustomer?.status !== "approved" && (
                              <Note danger>
                                当前客户尚未通过审核，无法创建报价。
                              </Note>
                            )}
                            <small className="quote-source">
                              {quote?.configVersion ?? "MOCK 报价源"}
                              <br />
                              样例费率，不构成实时市场报价
                            </small>
                          </>
                        ) : (
                          <>
                            <div className="circle-icon">
                              <Files size={34} />
                            </div>
                            <h3>逐笔校验，清晰可追踪</h3>
                            <ul className="clean-list">
                              <li>服务端校验白名单和客户范围</li>
                              <li>跨批次参考号去重，避免重复订单</li>
                              <li>提交时为有效行创建报价与订单</li>
                              <li>订单生成后仍需逐笔入金与出款</li>
                            </ul>
                            <Note>
                              不同币种不会混合合计。批次创建不代表付款成功。
                            </Note>
                          </>
                        )}
                      </aside>
                    </div>
                  ) : step === 2 && quote ? (
                    <div className="confirm-layout">
                      <section>
                        <div className="mobile-quote">
                          <p>收款人预计到账 · {quote.payoutCurrency}</p>
                          <strong>
                            {symbol(quote.payoutCurrency)}
                            {money(quote.payoutAmount)}
                          </strong>
                          <span>
                            <Clock size={17} />
                            报价有效期{" "}
                            <b>
                              {String(Math.floor(remaining / 60)).padStart(
                                2,
                                "0",
                              )}
                              :{String(remaining % 60).padStart(2, "0")}
                            </b>
                          </span>
                        </div>
                        <div className="card confirm-card">
                          <div className="card-heading">
                            <span className="muted">收款人</span>
                            <span className="success-text">
                              <ShieldCheck size={19} />
                              服务端白名单已验证
                            </span>
                          </div>
                          <h2>{recipient?.name}</h2>
                          <p>
                            {recipient?.accountMasked}
                            <br />
                            {quote.payoutCurrency === "CNY"
                              ? "中国大陆"
                              : "美国"}{" "}
                            · {quote.payoutCurrency}
                          </p>
                          <div className="ruleline" />
                          <h3>付款明细</h3>
                          <FeeRows quote={quote} />
                          <dl className="details">
                            <div>
                              <dt>金额输入方式</dt>
                              <dd>
                                {quote.amountMode === "total_deposit"
                                  ? "支付总额（含费用）"
                                  : "目标出款金额"}
                              </dd>
                            </div>
                            <div>
                              <dt>网络</dt>
                              <dd>MOCK · 无真实充值地址</dd>
                            </div>
                            <div>
                              <dt>报价版本</dt>
                              <dd>{quote.configVersion}</dd>
                            </div>
                          </dl>
                          <div className="receipt-info">
                            <FileText size={30} />
                            <div>
                              <strong>本金与手续费分别列明</strong>
                              <p>
                                应入金 {money(quote.totalDeposit)}{" "}
                                {quote.sourceCurrency}，其中本金{" "}
                                {money(quote.sourceAmount)}
                              </p>
                            </div>
                          </div>
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={busy}
                              onChange={(e) => setChecked(e.target.checked)}
                            />
                            我已核对模拟收款账户、费用与总额
                          </label>
                          {remaining === 0 && (
                            <Note danger>
                              报价已过期，请返回重新获取。服务器也会校验有效期。
                            </Note>
                          )}
                          <button
                            className="button full big"
                            disabled={locked || !checked || remaining === 0}
                            onClick={() => void createOrder()}
                          >
                            {busy ? "正在创建…" : "确认报价，创建 MOCK 订单"}{" "}
                            <ArrowRight size={20} />
                          </button>
                          <div className="actions centered">
                            <button
                              className="button text"
                              disabled={busy}
                              onClick={() => {
                                setStep(1);
                                setQuote(null);
                              }}
                            >
                              <ArrowLeft size={16} />
                              返回修改 / 重新报价
                            </button>
                          </div>
                        </div>
                      </section>
                      <aside className="confirm-aside">
                        <div className="circle-icon">
                          <ShieldCheck size={34} />
                        </div>
                        <h2>核对后，再确认</h2>
                        <p>
                          这份报价由服务端生成。到账金额、本金、服务费和渠道费都已列明。
                        </p>
                        <Note>
                          只有模拟网络与虚构账户。任何按钮都不会执行真实充值或付款。
                        </Note>
                      </aside>
                    </div>
                  ) : order ? (
                    <div className="deposit-layout">
                      <section className="card">
                        <div className="circle-icon">
                          <Wallet size={32} />
                        </div>
                        <h2>等待稳定币到账</h2>
                        <p>订单 {shortId(order.id)} · MOCK 网络</p>
                        {fundingPanel(order)}
                        <div className="actions">
                          <button
                            className="button"
                            onClick={() => go("detail")}
                          >
                            查看订单状态
                          </button>
                          <button
                            className="button outline"
                            disabled={busy}
                            onClick={() => void reload()}
                          >
                            刷新数据
                          </button>
                        </div>
                      </section>
                      <aside className="quote-panel">
                        <h2>订单状态</h2>
                        <dl className="details">
                          <div>
                            <dt>稳定币入金</dt>
                            <dd>
                              <Badge status={order.depositStatus} />
                            </dd>
                          </div>
                          <div>
                            <dt>法币出款</dt>
                            <dd>
                              <Badge status={order.payoutStatus} />
                            </dd>
                          </div>
                          <div>
                            <dt>付款回单</dt>
                            <dd>
                              <Badge status={order.receiptStatus} />
                            </dd>
                          </div>
                        </dl>
                        <button
                          className="button outline full"
                          disabled={busy}
                          onClick={() => {
                            setStep(1);
                            setQuote(null);
                            setChecked(false);
                          }}
                        >
                          再创建一笔付款
                        </button>
                      </aside>
                    </div>
                  ) : (
                    <Empty title="订单数据不可用，请刷新" />
                  )}
                </>
              )}
              {page === "recipients" && (
                <>
                  <div className="section-actions">
                    <Note>
                      只显示当前身份有权限读取的账户。新增项必须经过管理员审核。
                    </Note>
                    {(role === "customer" || maker) && (
                      <button
                        className="button"
                        disabled={
                          locked ||
                          !customers.some((c) => c.status === "approved")
                        }
                        onClick={() =>
                          openCommand({
                            title: "新增 MOCK 白名单收款人",
                            description:
                              "创建中国大陆 CNY 路线的虚构账户（尾号 8888）。仅使用虚构名称和账户引用，不收集银行账号。管理员审核通过后才可报价。",
                            path: "beneficiaries",
                            base: {
                              country: "CN",
                              currency: "CNY",
                              accountMasked: "**** 8888",
                              accountToken: "mock-vault-" + uid(),
                            },
                            fields: [
                              {
                                key: "customerId",
                                label: "所属演示客户",
                                value:
                                  role === "customer"
                                    ? customerId
                                    : (customers.find(
                                        (c) => c.status === "approved",
                                      )?.id ?? ""),
                                type: "select",
                                options: customers
                                  .filter((c) => c.status === "approved")
                                  .map((c) => [c.id, c.name]),
                              },
                              {
                                key: "name",
                                label: "虚构收款人名称",
                                value: "MOCK 新收款人",
                              },
                            ],
                            button: "提交白名单审核",
                            success: "收款人已保存为待审核，须由管理员确认。",
                          })
                        }
                      >
                        <Plus size={18} />
                        新增演示收款人
                      </button>
                    )}
                  </div>
                  <div className="recipient-grid">
                    {beneficiaries.map((b) => (
                      <div className="card recipient-card" key={b.id}>
                        <div className="card-heading">
                          <div className="circle-icon">
                            <Bank size={27} />
                          </div>
                          <Badge status={b.status} />
                        </div>
                        <h2>{b.name}</h2>
                        <p>{b.accountMasked}</p>
                        <span className="tag">
                          {b.country === "CN" ? "中国大陆" : "美国"} ·{" "}
                          {b.currency}
                        </span>
                        <p className="record-id">白名单 ID · {b.id}</p>
                        <div className="ruleline" />
                        <div className="actions">
                          {finance && b.status === "pending" ? (
                            <button
                              className="button outline"
                              disabled={locked || b.createdBy === actor}
                              onClick={() =>
                                void mutate(
                                  `beneficiaries/${b.id}/approve`,
                                  {},
                                  "白名单已通过服务端管理员审核。",
                                )
                              }
                            >
                              管理员审核通过
                            </button>
                          ) : (
                            <span className="muted small">
                              {b.status === "approved"
                                ? "已通过审核，可用于报价"
                                : "等待管理员审核"}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {!beneficiaries.length && (
                    <div className="card">
                      <Empty title="暂无可见收款人" />
                    </div>
                  )}
                </>
              )}
              {page === "certification" && (
                <>
                  {role === "admin" && maker && (
                    <div className="actions">
                      <button
                        className="button"
                        disabled={locked}
                        onClick={() =>
                          openCommand({
                            title: "新增演示客户",
                            description:
                              "创建待审核的虚构客户。不上传身份文件，不代表完成真实 KYC / KYB。",
                            path: "customers",
                            fields: [
                              {
                                key: "kind",
                                label: "主体类型",
                                value: "company",
                                type: "select",
                                options: [
                                  ["personal", "个人"],
                                  ["company", "企业"],
                                ],
                              },
                              {
                                key: "name",
                                label: "虚构客户名称",
                                value: "MOCK 新企业",
                              },
                            ],
                            button: "创建待审核客户",
                            success: "演示客户已创建，等待管理员审核。",
                          })
                        }
                      >
                        <Plus size={17} />
                        新增演示客户
                      </button>
                    </div>
                  )}
                  <div className="recipient-grid">
                    {customers.map((c) => (
                      <div className="card" key={c.id}>
                        <div className="card-heading">
                          <div className="circle-icon">
                            <ShieldCheck size={32} />
                          </div>
                          <Badge status={c.status} />
                        </div>
                        <h2>
                          {c.kind === "company" ? "企业认证" : "个人认证"} ·{" "}
                          {c.name}
                        </h2>
                        <p>来自服务端的演示主体资料。无需真实身份证件。</p>
                        <div className="demo-profile">
                          <div>
                            主体类型{" "}
                            <span>
                              {c.kind === "company"
                                ? "企业 KYB（样例）"
                                : "个人 KYC（样例）"}
                            </span>
                          </div>
                          <div>
                            身份文件 <span>未收集，未接入真实核验</span>
                          </div>
                          <div>
                            客户 ID <span>{c.id}</span>
                          </div>
                        </div>
                        {finance && (
                          <div className="actions">
                            {c.status !== "approved" && (
                              <button
                                className="button outline"
                                disabled={locked}
                                onClick={() =>
                                  void mutate(
                                    `customers/${c.id}/review`,
                                    { status: "approved" },
                                    "客户的 MOCK 审核状态已更新为通过。",
                                  )
                                }
                              >
                                审核通过
                              </button>
                            )}
                            {c.status === "approved" && (
                              <button
                                className="button outline"
                                disabled={locked}
                                onClick={() =>
                                  openCommand({
                                    title: "暂停演示客户",
                                    description:
                                      "暂停后，服务器会阻止该客户的新报价和受限资金操作。仅改变 MOCK 客户状态。",
                                    path: `customers/${c.id}/review`,
                                    base: { status: "suspended" },
                                    button: "暂停演示客户",
                                    success:
                                      "客户已暂停，后续操作由服务端权限与状态校验控制。",
                                  })
                                }
                              >
                                暂停客户
                              </button>
                            )}
                          </div>
                        )}
                        <Note>
                          本页面状态不代表已完成真实身份核验、合规审批或开户。
                        </Note>
                      </div>
                    ))}
                  </div>
                  {!customers.length && (
                    <Empty title="暂无当前身份可见的客户" />
                  )}
                </>
              )}
              {page === "orders" && orderTable()}
              {page === "detail" && (
                <>
                  <button
                    className="button text back"
                    onClick={() =>
                      go(role === "customer" ? "orders" : "workbench")
                    }
                  >
                    <ArrowLeft size={16} />
                    返回订单记录
                  </button>
                  {orderDetail(role === "admin")}
                </>
              )}
              {page === "workbench" && (
                <>
                  <div className="workspace-actions">
                    <span className="muted small">
                      同一后端 · {orders.length} 笔订单 ·{" "}
                      {
                        orders.filter((o) => o.payoutStatus === "unknown")
                          .length
                      }{" "}
                      笔结果待核实
                    </span>
                    {maker && (
                      <div className="workspace-controls">
                        <button
                          className="button outline"
                          disabled={locked}
                          onClick={seedScenario}
                        >
                          <Plus size={17} />
                          创建 MOCK 场景
                        </button>
                        {canResetDemoSession(actor, health?.persistence) && (
                          <button
                            className="button outline reset-session"
                            disabled={locked}
                            onClick={resetSession}
                            aria-label="重置当前会话演示数据"
                          >
                            <ArrowsClockwise size={17} />
                            重置当前会话
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="admin-layout">
                    <section>
                      {orderTable()}
                      {orderDetail(true)}
                    </section>
                    <aside>
                      {pricingPanel()}
                      <div className="card mini-note">
                        <ShieldCheck size={24} />
                        <h3>统一商家工作台</h3>
                        <p>
                          管理员线下付款后直接确认结果，上传截图或水单。未知结果先核实，禁止重复付款。
                        </p>
                        <Note>
                          所有操作受服务端控制。客户、商家和伙伴入口仅用于演示，不能替代正式登录。
                        </Note>
                      </div>
                    </aside>
                  </div>
                </>
              )}
              {page === "pricing" && (
                <div className="admin-layout">
                  <section>{pricingPanel()}</section>
                  <aside className="card">
                    <h2>订单报价快照</h2>
                    {order ? (
                      <>
                        <p>以下值读取自订单锁定快照。</p>
                        <dl className="details">
                          <div>
                            <dt>订单</dt>
                            <dd>{shortId(order.id)}</dd>
                          </div>
                          <div>
                            <dt>配置版本</dt>
                            <dd>{order.quote.configVersion}</dd>
                          </div>
                          <div>
                            <dt>客户汇率</dt>
                            <dd>{order.quote.customerRate}</dd>
                          </div>
                          <div>
                            <dt>到账金额</dt>
                            <dd>
                              {money(order.quote.payoutAmount)}{" "}
                              {order.quote.payoutCurrency}
                            </dd>
                          </div>
                          <div>
                            <dt>应入金总额</dt>
                            <dd>
                              {money(order.quote.totalDeposit)}{" "}
                              {order.quote.sourceCurrency}
                            </dd>
                          </div>
                        </dl>
                      </>
                    ) : (
                      <Empty title="尚无订单报价快照" />
                    )}
                    <Note>
                      成本价、参考价和客户价分别保存。定价参数仅为 MOCK
                      fixture。
                    </Note>
                  </aside>
                </div>
              )}
              {page === "reconciliation" && (
                <>
                  <div className="stat-grid">
                    <div className="card stat">
                      <div>
                        <span>待核对</span>
                        <strong>
                          {
                            orders.filter(
                              (o) => o.payoutStatus === "sent" && !o.reconciled,
                            ).length
                          }
                        </strong>
                        <small>已登记发送的订单</small>
                      </div>
                    </div>
                    <div className="card stat">
                      <div>
                        <span>未解决差异</span>
                        <strong className="red">
                          {data.discrepancies?.filter(
                            (d) => d.status === "open",
                          ).length ?? 0}
                        </strong>
                        <small>不同币种不混合合计</small>
                      </div>
                    </div>
                    <div className="card stat">
                      <div>
                        <span>核对一致</span>
                        <strong>
                          {orders.filter((o) => o.reconciled).length}
                        </strong>
                        <small>服务端证据校验通过</small>
                      </div>
                    </div>
                  </div>
                  <div className="card">
                    <div className="card-heading">
                      <h2>差异处理队列</h2>
                      <button
                        className="button outline"
                        disabled={busy}
                        onClick={() => void reload()}
                      >
                        <ArrowsClockwise size={16} />
                        刷新
                      </button>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>差异类型</th>
                            <th>订单</th>
                            <th>详情</th>
                            <th>状态</th>
                            <th>操作</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.discrepancies?.map((d) => (
                            <tr key={d.id}>
                              <td>{d.kind}</td>
                              <td>
                                {d.orderId ? shortId(d.orderId) : "未分配"}
                              </td>
                              <td className="wrap-cell">{d.detail}</td>
                              <td>
                                <Badge status={d.status} />
                              </td>
                              <td>
                                {finance && d.status === "open" && (
                                  <button
                                    className="button outline"
                                    disabled={locked}
                                    onClick={() =>
                                      openCommand({
                                        title: "提交差异处理依据",
                                        description:
                                          "服务端根据差异类型校验。未分配入金不能仅凭文字标记解决；需要实现相应资金分配流程。",
                                        path: `discrepancies/${d.id}/resolve`,
                                        fields: [
                                          evidence(
                                            "MOCK: independent investigation evidence",
                                          ),
                                        ],
                                        button: "提交处理依据",
                                        success:
                                          "差异处理请求已由服务端校验并保存。",
                                      })
                                    }
                                  >
                                    提交依据
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {!data.discrepancies?.length && (
                      <Empty title="暂无可见差异" />
                    )}
                    <Note>
                      对账不会改写客户报价。要核对某笔订单，请在出款工作台选择该订单直接核对付款记录。
                    </Note>
                  </div>
                  {orderTable()}
                </>
              )}
              {page === "audit" && (
                <div className="card">
                  <div className="card-heading">
                    <h2>服务端操作记录</h2>
                    <button
                      className="button outline"
                      disabled={!audits?.length}
                      onClick={() =>
                        downloadCSV("汇途-服务端审计记录.csv", [
                          ["time", "actor", "action", "target"],
                          ...(audits ?? []).map((a) => [
                            a.at,
                            a.actorId,
                            a.action,
                            a.targetId,
                          ]),
                        ])
                      }
                    >
                      <Download size={16} />
                      导出记录
                    </button>
                  </div>
                  {!finance && actor !== "auditor-demo" ? (
                    <Note>操作记录仅向商家管理员开放。</Note>
                  ) : auditError ? (
                    <Note danger>{auditError}</Note>
                  ) : audits === null ? (
                    <Empty title="正在读取审计记录" />
                  ) : !audits.length ? (
                    <Empty title="还没有操作记录">
                      服务器保存的关键操作将在这里显示。
                    </Empty>
                  ) : (
                    [...audits].reverse().map((a) => (
                      <div className="audit-row" key={a.id}>
                        <Clock size={18} />
                        <div>
                          <strong>{a.action}</strong>
                          <small>
                            {a.actorId} · {date(a.at)} · {shortId(a.targetId)}
                          </small>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
              {role === "partner" &&
                ["partner", "clients", "commissions", "settlements"].includes(
                  page,
                ) && (
                  <>
                    {page === "partner" && (
                      <>
                        <section className="invite-banner">
                          <div className="circle-icon">
                            <PaperPlaneTilt size={35} />
                          </div>
                          <div>
                            <h2>每笔服务费，清晰可查</h2>
                            <p>单层推荐 · 对账后计提 · 服务端观察期</p>
                          </div>
                          <div className="partner-banner-note">
                            <ShieldCheck size={20} />
                            <span>
                              仅返回脱敏客户和佣金
                              <br />
                              邀请注册尚未接入
                            </span>
                          </div>
                        </section>
                        <div className="stat-grid">
                          <div className="card stat">
                            <div className="circle-icon">
                              <CurrencyCircleDollar size={27} />
                            </div>
                            <div>
                              <span>可结算佣金记录</span>
                              <strong>
                                {
                                  commissionRows.filter(
                                    (c) => c.eligibility === "available",
                                  ).length
                                }
                                <em> 笔</em>
                              </strong>
                              <small>按币种和月份独立结算</small>
                            </div>
                          </div>
                          <div className="card stat">
                            <div className="circle-icon">
                              <Clock size={27} />
                            </div>
                            <div>
                              <span>观察期内</span>
                              <strong>
                                {
                                  commissionRows.filter(
                                    (c) => c.eligibility === "hold",
                                  ).length
                                }
                                <em> 笔</em>
                              </strong>
                              <small>服务端判定最早可结算时间</small>
                            </div>
                          </div>
                          <div className="card stat">
                            <div className="circle-icon">
                              <ChartBar size={27} />
                            </div>
                            <div>
                              <span>已批准结算单</span>
                              <strong>
                                {
                                  settlementRows.filter(
                                    (s) => s.status === "approved",
                                  ).length
                                }
                                <em> 张</em>
                              </strong>
                              <small>审批记录，不代表实际付款</small>
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                    <div className="card partner-details">
                      <div className="card-heading">
                        <div>
                          <h2>
                            {page === "settlements"
                              ? "月度结算记录"
                              : "客户与佣金明细"}
                          </h2>
                          <p>同一服务端 · 当前伙伴的授权数据范围</p>
                        </div>
                        <button
                          className="button outline"
                          disabled={!commissionRows.length}
                          onClick={() =>
                            downloadCSV("汇途-伙伴佣金.csv", [
                              [
                                "customerAlias",
                                "serviceFeeBase",
                                "currency",
                                "rate",
                                "commission",
                                "state",
                                "eligibility",
                                "eligibleAt",
                              ],
                              ...commissionRows.map((c) => [
                                c.customerAlias ?? "",
                                c.base,
                                c.currency,
                                c.rate,
                                c.value,
                                c.state,
                                c.eligibility ?? "",
                                c.eligibleAt,
                              ]),
                            ])
                          }
                        >
                          <Download size={17} />
                          下载明细
                        </button>
                      </div>
                      <div className="tabs">
                        {[
                          ["clients", "我的客户"],
                          ["commissions", "佣金明细"],
                          ["settlements", "结算记录"],
                        ].map(([p, label]) => (
                          <button
                            key={p}
                            className={
                              page === p ||
                              (page === "partner" && p === "commissions")
                                ? "active"
                                : ""
                            }
                            onClick={() => go(p as Page)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      {page === "settlements" ? (
                        settlementsTable()
                      ) : page === "clients" ? (
                        <>
                          <div className="table-scroll">
                            <table>
                              <thead>
                                <tr>
                                  <th>客户别名</th>
                                  <th>佣金记录数</th>
                                  <th>数据范围</th>
                                </tr>
                              </thead>
                              <tbody>
                                {[
                                  ...new Set(
                                    commissionRows
                                      .map((c) => c.customerAlias)
                                      .filter(Boolean),
                                  ),
                                ].map((alias) => (
                                  <tr key={alias}>
                                    <td>{alias}</td>
                                    <td>
                                      {
                                        commissionRows.filter(
                                          (c) => c.customerAlias === alias,
                                        ).length
                                      }
                                    </td>
                                    <td>无本金、身份文件或银行账户</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          {!commissionRows.length && (
                            <Empty title="暂无有佣金记录的客户" />
                          )}
                          <Note>
                            此列表只从当前伙伴的佣金记录归纳客户别名，不代表全部邀请或注册客户。
                          </Note>
                        </>
                      ) : (
                        commissionTable()
                      )}
                    </div>
                    <section className="card settlement-bar">
                      <div>
                        <h2>月度结算</h2>
                        <p>管理员生成草稿并确认结算记录</p>
                      </div>
                      <div className="actions">
                        <button
                          className="button outline"
                          onClick={() => go("settlements")}
                        >
                          查看结算记录
                        </button>
                      </div>
                    </section>
                  </>
                )}
              {role === "admin" && page === "settlements" && (
                <>
                  <div className="card">
                    <div className="card-heading">
                      <div>
                        <h2>佣金结算管理</h2>
                        <p>
                          仅对已关闭月份、符合观察期与冻结规则的记录生成结算单。
                        </p>
                      </div>
                      {finance && (
                        <button
                          className="button"
                          disabled={locked}
                          onClick={() => {
                            const d = new Date();
                            d.setUTCDate(1);
                            d.setUTCMonth(d.getUTCMonth() - 1);
                            openCommand({
                              title: "生成月度结算草稿",
                              description:
                                "服务端按币种、月份、观察期及冻结状态筛选佣金。无可结算金额时会明确拒绝，不会生成虚假余额。",
                              path: "settlements",
                              fields: [
                                {
                                  key: "partnerId",
                                  label: "演示伙伴 ID",
                                  value: "partner-1",
                                },
                                {
                                  key: "month",
                                  label: "已关闭月份",
                                  value: d.toISOString().slice(0, 7),
                                  type: "month",
                                },
                                {
                                  key: "currency",
                                  label: "结算币种",
                                  value: "USDT",
                                  type: "select",
                                  options: [
                                    ["USDT", "USDT"],
                                    ["USDC", "USDC"],
                                  ],
                                },
                              ],
                              button: "生成服务端草稿",
                              success: "月度结算草稿已生成，请核对后确认。",
                            });
                          }}
                        >
                          生成结算草稿
                        </button>
                      )}
                    </div>
                    {!finance && actor !== "auditor-demo" ? (
                      <Note>佣金明细与结算记录仅向商家管理员开放。</Note>
                    ) : (
                      <>
                        {settlementsTable()}
                        <div className="ruleline" />
                        <h3>服务端佣金记录</h3>
                        {commissionTable()}
                      </>
                    )}
                  </div>
                </>
              )}
            </>
          )}
          <footer>
            <span>
              <ShieldCheck size={15} />
              MOCK 模式，无真实资金操作
            </span>
            <span>{storageLabel}</span>
            <button onClick={() => setSupport((v) => !v)}>查看边界说明</button>
          </footer>
        </main>
        <nav
          className={"mobile-nav " + (role === "admin" ? "admin-mobile" : "")}
          aria-label="移动导航"
        >
          {navs[role].map(([p, label, I]) => (
            <button
              key={p}
              className={
                page === p || (p === "orders" && page === "detail")
                  ? "active"
                  : ""
              }
              onClick={() => go(p)}
            >
              <I size={21} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle size={19} />
          {toast}
        </div>
      )}
      {command && (
        <Modal
          title={command.title}
          busy={busy}
          onClose={() => setCommand(null)}
        >
          <p>{command.description}</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitCommand();
            }}
          >
            {command.fields?.map((field) => (
              <label key={field.key}>
                {field.label}
                {field.type === "select" ? (
                  <select
                    required
                    disabled={busy}
                    value={commandValues[field.key] ?? ""}
                    onChange={(e) =>
                      setCommandValues((v) => ({
                        ...v,
                        [field.key]: e.target.value,
                      }))
                    }
                  >
                    {field.options?.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                ) : field.type === "textarea" ? (
                  <textarea
                    required
                    disabled={busy}
                    maxLength={500}
                    rows={3}
                    value={commandValues[field.key] ?? ""}
                    onChange={(e) =>
                      setCommandValues((v) => ({
                        ...v,
                        [field.key]: e.target.value,
                      }))
                    }
                  />
                ) : (
                  <input
                    required
                    disabled={busy}
                    type={field.type === "month" ? "month" : "text"}
                    maxLength={500}
                    value={commandValues[field.key] ?? ""}
                    onChange={(e) =>
                      setCommandValues((v) => ({
                        ...v,
                        [field.key]: e.target.value,
                      }))
                    }
                  />
                )}
              </label>
            ))}
            <Note>此操作仅发送到隔离 MOCK API，不执行真实转账。</Note>
            {commandError && (
              <div className="modal-error" role="alert">
                {commandError}
              </div>
            )}
            <div className="actions">
              <button
                type="button"
                className="button outline"
                disabled={busy}
                onClick={() => setCommand(null)}
              >
                取消
              </button>
              <button type="submit" className="button" disabled={locked}>
                {busy ? "正在提交…" : command.button}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
