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
  recipients: "管理可信任的收款账户，独立审核后可用",
  orders: "资金到账、换汇、出款与回单，分别追踪",
  detail: "每一步资金状态，都有清晰记录",
  certification: "来自服务端的演示客户审核状态",
  workbench: "合作方后台人工出款，经办与财务独立复核",
  pricing: "服务端样例配置与不可覆盖的报价快照",
  reconciliation: "核对模拟渠道参考号、金额与证据",
  audit: "来自服务端的脱敏操作记录",
  partner: "查看服务费佣金与月度结算",
  clients: "仅显示已产生佣金记录的脱敏客户",
  commissions: "按独立对账后的服务费计提，保留退款调整",
  settlements: "服务端结算草稿与独立批准记录",
};
const actors: [ActorKey, string][] = [
  ["customer-demo", "客户 · 个人"],
  ["company-demo", "客户 · 企业"],
  ["maker-demo", "运营 · 经办 A"],
  ["checker-demo", "财务 · 复核 B"],
  ["checker-two-demo", "财务 · 复核 C"],
  ["auditor-demo", "审计 · 只读"],
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
  const finance = actor === "checker-demo" || actor === "checker-two-demo";
  const maker = actor === "maker-demo";
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
  const [enteredAmount, setEnteredAmount] = useState("1000.00");
  const [amountMode, setAmountMode] = useState<"total_deposit" | "principal">(
    "total_deposit",
  );
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
    if (!/^(0|[1-9]\d{0,19})(\.\d{1,6})?$/.test(enteredAmount)) {
      setQuoteError("请输入正数金额，最多 6 位小数");
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
          sourceAmount: enteredAmount,
          amountMode,
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
        "服务端通过领域方法创建三笔关联样例：已入金待换汇、已复核待记录结果、已对账待观察期佣金。再次点击返回同一组样例，不重置或覆盖已有订单。",
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
                      {o.receiptStatus === "none" ? "待补充" : "已登记元数据"}
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
                : "可以先创建 MOCK 场景，再切换经办与财务验证流程。"}
            </Empty>
          )}
        </div>
      </div>
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
            <small>收款人到账金额</small>
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
            <small>独立对账</small>
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
        <dl className="details">
          <div>
            <dt>金额输入方式</dt>
            <dd>
              {o.quote.amountMode === "total_deposit"
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
                o.payoutStatus === "draft"
                  ? 1
                  : o.payoutStatus === "awaiting_approval"
                    ? 2
                    : 3
              }
              labels={["经办提交", "独立复核", "记录结果"]}
            />
            <div className="actions">
              {maker && o.depositStatus === "awaiting" && (
                <button
                  className="button"
                  disabled={locked}
                  onClick={() =>
                    openCommand({
                      title: "生成签名 MOCK 入金事件",
                      description:
                        "服务端为该订单生成金额完全匹配的模拟入金事件并验签处理。不会提供真实地址或执行真实链上转账。过期订单会按服务端规则进入异常队列。",
                      path: `demo/orders/${o.id}/deposit`,
                      button: "模拟准确入金",
                      success:
                        "MOCK 入金事件已由服务端处理，请核对最新入金状态。",
                    })
                  }
                >
                  模拟准确入金
                </button>
              )}
              {finance &&
                o.depositStatus === "confirmed" &&
                o.conversionStatus === "pending" &&
                !blockedByRefund && (
                  <button
                    className="button"
                    disabled={locked}
                    onClick={() =>
                      openCommand({
                        title: "登记外部换汇结果",
                        description:
                          "记录已经发生的 MOCK 换汇分配，不执行交易。实际汇率必须与订单目标金额一致，服务端会验证。",
                        path: `orders/${o.id}/conversion`,
                        fields: [
                          reference("fx_" + o.id),
                          {
                            key: "actualRate",
                            label: "实际分配汇率",
                            value: o.quote.customerRate,
                          },
                          evidence(
                            "MOCK: externally allocated conversion evidence",
                          ),
                        ],
                        button: "登记 MOCK 换汇",
                        success: "外部换汇已登记，经办可以准备出款。",
                      })
                    }
                  >
                    登记外部换汇
                  </button>
                )}
              {maker &&
                o.conversionStatus === "recorded" &&
                ["draft", "failed"].includes(o.payoutStatus) &&
                !blockedByRefund && (
                  <button
                    className="button"
                    disabled={locked || o.depositStatus !== "confirmed"}
                    onClick={() =>
                      void mutate(
                        `orders/${o.id}/attempts`,
                        {
                          idempotencyKey:
                            "web_pay_" + o.id + "_" + (attempt?.id ?? "first"),
                        },
                        "出款申请已提交，请切换财务身份独立复核。",
                      )
                    }
                  >
                    经办提交出款
                  </button>
                )}
              {finance && attempt?.state === "awaiting_approval" && (
                <button
                  className="button"
                  disabled={locked || attempt.makerId === actor}
                  onClick={() =>
                    void mutate(
                      `attempts/${attempt.id}/approve`,
                      {},
                      "独立复核通过，等待经办登记模拟渠道结果。",
                    )
                  }
                >
                  复核通过
                </button>
              )}
              {maker && attempt?.state === "approved" && (
                <>
                  <button
                    className="button"
                    disabled={locked || attempt.makerId !== actor}
                    onClick={() =>
                      openCommand({
                        title: "记录模拟渠道发送",
                        description:
                          "“已发送”仅代表登记渠道结果，仍需财务独立对账。此操作不会向银行或链上提交付款。",
                        path: `attempts/${attempt.id}/record`,
                        base: { outcome: "sent" },
                        fields: [
                          reference("mock_" + attempt.id),
                          evidence("MOCK: portal success confirmation"),
                        ],
                        button: "登记已发送",
                        success:
                          "渠道发送结果已登记，等待独立对账；回单可后补。",
                      })
                    }
                  >
                    记录已发送
                  </button>
                  <button
                    className="button outline"
                    disabled={locked || attempt.makerId !== actor}
                    onClick={() =>
                      openCommand({
                        title: "记录结果未知",
                        description:
                          "渠道超时或结果不明确。服务端会锁定重试与退款，必须先由财务核实实际结果。",
                        path: `attempts/${attempt.id}/record`,
                        base: { outcome: "unknown" },
                        fields: [
                          evidence("MOCK: portal timed out, result unknown"),
                        ],
                        button: "登记结果未知",
                        success: "未知结果已记录，重试和退款已被服务端锁定。",
                      })
                    }
                  >
                    结果未知
                  </button>
                </>
              )}
              {finance && attempt?.state === "unknown" && (
                <>
                  <button
                    className="button"
                    disabled={locked}
                    onClick={() =>
                      openCommand({
                        title: "独立核实已发送",
                        description:
                          "请提供 MOCK 查询结果和渠道参考号。核实后仍需独立对账。",
                        path: `attempts/${attempt.id}/resolve`,
                        base: { outcome: "sent" },
                        fields: [
                          reference("mock_" + attempt.id),
                          evidence(
                            "MOCK: provider independently confirms transfer exists",
                          ),
                        ],
                        button: "核实已发送",
                        success: "已独立核实发送结果，等待对账。",
                      })
                    }
                  >
                    核实已发送
                  </button>
                  <button
                    className="button outline"
                    disabled={locked}
                    onClick={() =>
                      openCommand({
                        title: "独立核实未付款",
                        description:
                          "仅在查询证据确认未发生转账时解除未知状态。后续重试需要重新经办和复核。",
                        path: `attempts/${attempt.id}/resolve`,
                        base: { outcome: "failed" },
                        fields: [
                          evidence(
                            "MOCK: provider independently confirms no transfer exists",
                          ),
                        ],
                        button: "核实未付款",
                        success: "已核实未付款，经办可创建新出款申请。",
                      })
                    }
                  >
                    核实未付款
                  </button>
                </>
              )}
              {finance && o.payoutStatus === "sent" && !o.reconciled && (
                <button
                  className="button"
                  disabled={locked}
                  onClick={() =>
                    openCommand({
                      title: "核对渠道记录",
                      description:
                        "服务端核对渠道参考号与实际金额；不一致会进入差异队列。对账通过才可产生符合规则的佣金。",
                      path: `orders/${o.id}/reconcile`,
                      fields: [
                        reference(attempt?.providerReference ?? ""),
                        {
                          key: "actualAmount",
                          label:
                            "渠道实际金额（" + o.quote.payoutCurrency + "）",
                          value: o.quote.payoutAmount,
                        },
                        evidence(
                          "MOCK: provider statement independently matched",
                        ),
                      ],
                      button: "提交独立对账",
                      success: "对账请求已处理，请核对最新订单与差异状态。",
                    })
                  }
                >
                  核对渠道记录
                </button>
              )}
            </div>
            {o.depositStatus === "awaiting" && (
              <Note>
                等待签名验证的 MOCK 入金事件。浏览器不持有 webhook
                签名密钥，也不提供充值地址。
              </Note>
            )}
            {o.depositStatus === "confirmed" &&
              o.conversionStatus === "pending" &&
              !blockedByRefund &&
              !finance && (
                <p className="muted small">
                  下一步：切换财务身份，先登记外部换汇分配。
                </p>
              )}
            {o.payoutStatus === "awaiting_approval" && !finance && (
              <p className="muted small">
                下一步：切换财务复核 B 或 C，审核经办提交的出款。
              </p>
            )}
            {o.payoutStatus === "approved" && !maker && (
              <p className="muted small">
                下一步：切换运营经办 A，登记模拟渠道结果。
              </p>
            )}
            {o.payoutStatus === "sent" && (
              <span className="success-text">
                <CheckCircle size={18} />
                {o.reconciled
                  ? "已发送并独立对账一致"
                  : "发送结果已登记，仍待独立对账"}
              </span>
            )}
            <p className="muted small">
              权限、状态迁移、幂等与经办复核分离均由服务端强制校验。
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
                changeActor("maker-demo");
                setSelected(o.id);
              }}
            >
              查看管理演示 <ArrowUpRight size={16} />
            </button>
          </div>
        )}
        {o.payoutStatus === "unknown" && (
          <Note danger>
            出款结果未知。禁止重复出款与退款，须由财务提供独立查询依据。
          </Note>
        )}
        <div className="receipt-row">
          <FileText size={30} />
          <div>
            <strong>客户回单 · 元数据</strong>
            <p>
              {o.receiptStatus === "none"
                ? "发送后可补录，不改变出款状态"
                : "已登记私有对象引用，尚未接入实际文件存储"}
            </p>
          </div>
          {admin && (maker || finance) ? (
            <button
              className="button outline"
              disabled={
                locked ||
                o.payoutStatus !== "sent" ||
                o.receiptStatus !== "none"
              }
              onClick={() =>
                openCommand({
                  title: "登记回单元数据",
                  description:
                    "这里只保存一个 MOCK 私有对象引用，不上传或生成文件，不构成付款凭证。实际文件上传和下载尚未接入。",
                  path: `orders/${o.id}/receipt-metadata`,
                  fields: [
                    {
                      key: "objectKey",
                      label: "MOCK 私有对象引用",
                      value: "receipts/" + o.id + "/mock-receipt.pdf",
                    },
                  ],
                  button: "登记元数据",
                  success:
                    "回单元数据已登记；没有上传实际文件，出款状态未改变。",
                })
              }
            >
              <Upload size={16} />
              {o.receiptStatus === "none" ? "登记元数据" : "已登记"}
            </button>
          ) : (
            <Badge status={o.receiptStatus}>
              {o.receiptStatus === "none" ? "等待平台补充" : "仅元数据"}
            </Badge>
          )}
        </div>
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
                      "仅创建 MOCK 退款预留记录，仍需独立审批与经办登记。服务端校验累计金额上限，不执行实际退款。",
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
                    success: "退款申请已预留，等待财务独立审批。",
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
                  disabled={locked || r.makerId === actor}
                  onClick={() =>
                    void mutate(
                      `refunds/${r.id}/approve`,
                      {},
                      "退款已独立审批，等待原经办登记结果。",
                    )
                  }
                >
                  审批退款
                </button>
              )}
              {maker && r.status === "approved" && (
                <button
                  className="button outline"
                  disabled={locked || r.makerId !== actor}
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
                            disabled={locked || s.makerId === actor}
                            onClick={() =>
                              void mutate(
                                `settlements/${s.id}/approve`,
                                {},
                                "结算单已独立批准。本系统不执行或记录实际佣金付款。",
                              )
                            }
                          >
                            独立批准
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
            财务可为已关闭月份的合格佣金生成草稿。伙伴只读查看。
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
            关联订单发送并通过独立对账后，才会由服务端按规则计提。
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
                客户：选择支付总额或兑换本金 → 核对服务端报价 →
                创建订单。管理员：创建 MOCK 场景 → 财务登记换汇 → 经办提交 →
                财务复核 → 经办记录结果 →
                财务对账。伙伴：查看同一服务端产生的佣金与观察期。
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
                              <button
                                type="button"
                                disabled={busy}
                                aria-pressed={amountMode === "principal"}
                                className={
                                  amountMode === "principal" ? "active" : ""
                                }
                                onClick={() =>
                                  editForm(() => setAmountMode("principal"))
                                }
                              >
                                兑换本金（费用另加）
                              </button>
                            </div>
                            <label>
                              {amountMode === "total_deposit"
                                ? "支付总额（含费用）"
                                : "兑换本金（费用另加）"}
                              <div className="input-unit amount">
                                <input
                                  aria-label={
                                    amountMode === "total_deposit"
                                      ? "支付总额（含费用）"
                                      : "兑换本金（费用另加）"
                                  }
                                  inputMode="decimal"
                                  value={enteredAmount}
                                  disabled={busy}
                                  onChange={(e) =>
                                    editForm(() =>
                                      setEnteredAmount(e.target.value),
                                    )
                                  }
                                />
                                <select
                                  aria-label="稳定币"
                                  value={asset}
                                  disabled={busy}
                                  onChange={(e) =>
                                    editForm(() => setAsset(e.target.value))
                                  }
                                >
                                  <option>USDT</option>
                                  <option>USDC</option>
                                </select>
                              </div>
                            </label>
                            <div className="form-grid">
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
                                    : "请先新增并由财务审核白名单"}
                                </p>
                              </div>
                              <ShieldCheck size={22} className="teal" />
                            </div>
                            <div className="purpose">
                              <Note>
                                {amountMode === "total_deposit"
                                  ? "支付总额已包含服务费与通道费，扣除费用后的本金用于兑换。"
                                  : "手续费在本金之外另收。应入金总额 = 兑换本金 + 平台服务费 + 通道费。"}
                              </Note>
                            </div>
                            <p className="subtle">
                              <Info size={16} />
                              报价、费用与到账金额均由服务端计算
                            </p>
                            <div className="bottom-note">
                              <FileText size={20} />
                              回单元数据可后补，实际文件存储尚未接入
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
                                : "本金用于兑换，手续费另加"}
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
                                  : "兑换本金（费用另加）"}
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
                        <div className="deposit-number">
                          {money(order.quote.totalDeposit)}{" "}
                          <span>{order.quote.sourceCurrency}</span>
                        </div>
                        <div className="demo-address">
                          <Lock size={19} />
                          <strong>MOCK ONLY · 无真实充值地址</strong>
                        </div>
                        <Note>
                          不要向任何地址转账。该订单等待签名验证的 MOCK
                          入金事件。管理员可创建独立的演示场景验证出款流程。
                        </Note>
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
                            <dt>回单元数据</dt>
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
                      只显示当前身份有权限读取的账户。新增项必须经过财务独立审核。
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
                              "创建中国大陆 CNY 路线的虚构账户（尾号 8888）。仅使用虚构名称和账户引用，不收集银行账号。财务独立审核通过后才可报价。",
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
                            success: "收款人已保存为待审核，须由财务独立审批。",
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
                                  "白名单已通过服务端独立审核。",
                                )
                              }
                            >
                              独立审核通过
                            </button>
                          ) : (
                            <span className="muted small">
                              {b.status === "approved"
                                ? "已通过审核，可用于报价"
                                : "等待财务身份独立审核"}
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
                            success: "演示客户已创建，等待财务审核。",
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
                        <h3>经办与复核分离</h3>
                        <p>
                          先登记换汇分配，再由经办提交。独立财务复核后，原经办记录渠道结果。未知结果先核实，禁止重复付款。
                        </p>
                        <Note>
                          所有操作受服务端控制。角色切换仅是隔离演示入口。
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
                        <span>待独立核对</span>
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
                      对账不会改写客户报价。要核对某笔订单，请在出款工作台选择该订单并使用财务身份。
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
                    <Note>
                      审计日志仅向财务与审计身份开放，请切换角色查看。
                    </Note>
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
                            <p>单层推荐 · 独立对账后计提 · 服务端观察期</p>
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
                        <p>由财务生成草稿，另一位财务独立批准</p>
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
                              success:
                                "月度结算草稿已生成，请另一位财务独立批准。",
                            });
                          }}
                        >
                          生成结算草稿
                        </button>
                      )}
                    </div>
                    {!finance && actor !== "auditor-demo" ? (
                      <Note>佣金明细与结算记录仅向财务、审计身份开放。</Note>
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
