"use client";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
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
import MerchantOverview, {
  matchesMerchantQueue,
  type MerchantQueue,
} from "./MerchantOverview";
import OrderHistory from "./OrderHistory";
import CustomerWallet from "./CustomerWallet";
import CustomerOrders from "./CustomerOrders";
import "./exchange-flow.css";
import { customerOrderState } from "./customer-order-models";
import "./customer-workspace.css";
import { batchProgress, batchResultLabel } from "./batch-progress";
import ReceiptLibrary from "./ReceiptLibrary";
import MerchantBatchImport from "./MerchantBatchImport";
import "./merchant-import.css";
import PublishedReceipts from "./PublishedReceipts";
import {
  OverviewPanel,
  PricingSettingsPanel,
  PayoutProvidersPanel,
  CustomerDirectoryPanel,
  ReferralPartnersPanel,
} from "./AdminPanels";
import type { PricingInput, PricingVersion } from "./admin-models";
import type { Icon } from "@phosphor-icons/react";
import { Badge, Note, Steps, FeeRows, Empty, Modal, downloadCSV } from "./ui";
import {
  money,
  quoteAmountInput,
  validQuoteAmount,
  hasWalletFunds,
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
  type BatchPreview,
  batchErrorLabel,
  recipientUsable,
  canQuickMockConfirm,
  type Audit,
} from "./models";

import { WorkspaceContext } from "./workspace-context";
import RouteSettings from "./RouteSettings";

type Page =
  | "routes"
  | "wallet"
  | "profile"
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
  | "settlements"
  | "overview"
  | "directory"
  | "providers"
  | "referrals"
  | "receipts";
type Field = {
  key: string;
  label: string;
  value: string;
  type?: "text" | "textarea" | "select" | "month";
  options?: [string, string][];
  required?: boolean;
};
type Command = {
  title: string;
  description: string;
  path: string;
  base?: Record<string, string>;
  fields?: Field[];
  review?: [string, string][];
  button: string;
  success: string;
};
const navs: Record<ViewRole, [Page, string, Icon][]> = {
  customer: [
    ["wallet", "钱包", Wallet],
    ["payment", "结汇", CurrencyCircleDollar],
    ["orders", "订单", FileText],
    ["profile", "用户中心", User],
    ["routes", "出款地区", Bank],
  ],
  admin: [
    ["overview", "经营概览", ChartBar],
    ["routes", "路线配置", Bank],
    ["workbench", "出款工作台", Wallet],
    ["orders", "全部订单", FileText],
    ["receipts", "回单资料库", Files],
    ["directory", "用户与商户", Users],
    ["providers", "出款合作方", Bank],
    ["referrals", "推广伙伴", Users],
    ["recipients", "收款账户", User],
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
  routes: "人工代付路线",
  receipts: "回单资料库",
  overview: "经营概览",
  directory: "用户与商户",
  providers: "出款合作方",
  referrals: "推广伙伴",
  wallet: "钱包资产",
  profile: "用户中心",
  payment: "结汇",
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
  routes: "首批六个法币方向，线下付款，汇率和费用按路线配置",
  receipts: "私有存储、本地识别、人工关联，原件不会自动分享给客户",
  overview: "按订单创建、登记付款分别统计，不同币种独立核算",
  directory: "查看个人与企业资料、账户和订单，不涉及真实身份认证",
  providers: "管理实际出款角色，与推广返佣伙伴完全分开",
  referrals: "查看推广归属与服务费佣金，不承担订单出款",
  wallet: "先模拟充值，再用可用余额结汇；资金状态一目了然",
  profile: "管理演示身份与常用收款账户",
  payment: "从钱包余额兑换法币，汇率、费用与到账金额透明列明",
  recipients: "收款账户保存后即可使用，系统自动检查必填项、格式与币种",
  orders: "付款确认即完成，回单可选补充，异常单独处理",
  detail: "每一步资金状态，都有清晰记录",
  certification: "来自服务端的演示客户审核状态",
  workbench: "核对收款信息后确认完成，回单可后补，未知结果先核实",
  pricing: "模拟基准加管理员调整，先预览再发布，新报价使用新版本",
  reconciliation: "处理异常与历史待复核记录，正常完成订单无需再次核对",
  audit: "来自服务端的脱敏操作记录",
  partner: "查看服务费佣金与月度结算",
  clients: "仅显示已产生佣金记录的脱敏客户",
  commissions: "按确认完成后的服务费计提，保留冻结期与退款调整",
  settlements: "服务端结算草稿与批准记录",
};
const actors: [ActorKey, string][] = [
  ["customer-demo", "客户 · 个人"],
  ["company-demo", "商户 · 企业客户"],
  ["admin-demo", "平台 · 运营管理员"],
  ["partner-demo", "合作伙伴"],
];
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "请求失败，请重试";
const uid = () => crypto.randomUUID();

export default function Home() {
  const workspace = useContext(WorkspaceContext);
  const [actor, setActor] = useState<ActorKey>(() => workspace?.account.role === "merchant_admin" ? "admin-demo" : workspace?.account.kind === "company" ? "company-demo" : "customer-demo");
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
  const [page, setPage] = useState<Page>(workspace?.account.role === "merchant_admin" ? "overview" : "wallet");
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
  const [profileTab, setProfileTab] = useState("home");
  const [resumeDraft, setResumeDraft] = useState(false);
  const [batchChecked, setBatchChecked] = useState(false);
  const [batchPreview, setBatchPreview] = useState<BatchPreview | null>(null);
  const [merchantQueue, setMerchantQueue] = useState<MerchantQueue>("all");
  const [enteredAmount, setEnteredAmount] = useState("1000.00");
  const [amountMode, setAmountMode] = useState<
    "total_deposit" | "target_payout"
  >("total_deposit");
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
  const [receiptOrderId, setReceiptOrderId] = useState("");
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
  const customerId = workspace ? (workspace.account.customerId ?? "") : actor === "company-demo" ? "customer-2" : "customer-1";
  const currentCustomer = customers.find((c) => c.id === customerId);
  const usableBeneficiaries = beneficiaries.filter(
    (b) =>
      b.customerId === customerId &&
      recipientUsable(b.status) &&
      b.currency === market,
  );
  const recipient =
    usableBeneficiaries.find((b) => b.id === beneficiaryId) ??
    usableBeneficiaries[0];
  const chosenBeneficiaryId = recipient?.id ?? "";
  const order = orders.find((o) => o.id === selected) ?? orders[0];
  const commissionRows = data?.commissions ?? [];
  const settlementRows = data?.settlements ?? [];
  const usable = connection === "connected" && !!data;
  const locked = busy || !usable;
  const walletBalances =
    data?.walletBalances?.filter((w) => w.customerId === customerId) ?? [];
  const sourceBalance = walletBalances.find((w) => w.currency === asset);
  const enoughBalance =
    !!quote && hasWalletFunds(sourceBalance?.available, quote.totalDeposit);
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
      responseType: "json" | "blob" = "json",
    ): Promise<T> => {
      const response = await fetch((workspace ? "/workspace/api/" : "/api/") + path, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...(workspace ? {} : { "x-demo-actor": actor }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
      });
      const result =
        response.ok && responseType === "blob"
          ? await response.blob()
          : await response.json().catch(() => null);
      if (!response.ok) {
        if (workspace && response.status === 401) workspace.expired();
        if (result?.error === "SESSION_EXPIRED" && actorRef.current === actor) {
          // Never replay a mutation into a newly created session. Require a fresh, explicit dashboard read.
          reloadId.current += 1;
          setDataState(null);
          setConnection("error");
          setQuote(null);
          setStep(1);
          setChecked(false);
          setBatch(null);
          setBatchPreview(null);
          setBatchText("");
          setBatchKey("");
          setAudits(null);
          setSelected("");
          setToast("");
          setCommand(null);
          setCommandValues({});
          setBeneficiaryId("");
          setEnteredAmount("1000.00");
          setResumeDraft(false);
          setBatchChecked(false);
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
      if (actorRef.current !== actor)
        throw new Error("身份已切换，请在当前入口重新操作");
      if (result === null) throw new Error("API 未返回可读取的数据");
      return result as T;
    },
    [actor, workspace],
  );

  const receiptRequest = useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const body =
        init?.body === undefined ? undefined : JSON.parse(String(init.body));
      return request<T>(
        path.replace(/^\/?api\//, ""),
        body,
        init?.signal ?? undefined,
      );
    },
    [request],
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
    setBatchPreview(null);
    setBatchText("");
    setBatchKey("");
    setAudits(null);
    setAuditError("");
    setError("");
    setResumeDraft(false);
    setBatchChecked(false);
    setReceiptOrderId("");
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

  async function previewPricing(
    input: PricingInput,
  ): Promise<PricingVersion | null> {
    if (busyRef.current || !usable) return null;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await request<PricingVersion>(
        "admin/pricing/preview",
        input,
      );
      return actorRef.current === actor ? result : null;
    } catch (e) {
      if (actorRef.current === actor) setError(errorText(e));
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
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
        setBatchPreview(null);
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
      if (actorRef.current !== actor) return null;
      setError(errorText(e));
      setCommandError(errorText(e));
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function go(next: Page) {
    if (page === "payment" && next !== "payment" && step >= 2) {
      setStep(1);
      setQuote(null);
      setChecked(false);
    }
    if (next === "payment" && step === 2 && !quote) {
      setStep(1);
      setChecked(false);
    }
    setPage(next);
    setFilter("all");
    setSearch("");
    setMerchantQueue("all");
    if (next === "profile") setProfileTab("home");
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
    setMode("single");
    setResumeDraft(false);
    setBatchChecked(false);
    go(navs[nextRole][0][0]);
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
    const payload = { ...command.base, ...commandValues };
    if (command.path === "beneficiaries") {
      payload.name = (payload.name ?? "").trim();
      if (!payload.name || payload.name.length > 100) {
        setCommandError("请填写收款人名称，最多 100 个字符。");
        return;
      }
      if (!/^\*{4} \d{4}$/.test(payload.accountMasked ?? "")) {
        setCommandError(
          "演示账户请按 **** 8888 格式填写，仅保留四位尾号，不填写完整账号。",
        );
        return;
      }
    }
    const result = await mutate<{ id?: string }>(
      command.path,
      payload,
      command.success,
    );
    if (result !== null) {
      setCommand(null);
      if (
        command.path === "beneficiaries" &&
        role === "customer" &&
        result.id
      ) {
        setBeneficiaryId(result.id);
        setQuote(null);
        setChecked(false);
        setQuoteVersion((v) => v + 1);
      }
      if (command.path === "wallet/deposits") {
        setQuote(null);
        setChecked(false);
        setQuoteVersion((v) => v + 1);
      }
    }
  }
  async function createOrder() {
    if (!quote || !checked || remaining === 0 || !enoughBalance) return;
    const result = await mutate<Order>(
      "orders",
      {
        quoteId: quote.id,
        clientOrderId: "web_" + quote.id,
        fundingSource: "wallet",
      },
      "结汇订单已创建，对应模拟余额已冻结，无需再次充值。",
    );
    if (result) {
      setSelected(result.id);
      setResumeDraft(false);
      setStep(3);
    }
  }
  function template(withErrors = false) {
    const available = beneficiaries.filter(
      (b) => b.customerId === customerId && recipientUsable(b.status),
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
    if (result) {
      setBatch(result);
      setBatchChecked(false);
      setBatchPreview(null);
    }
  }
  async function previewBatch() {
    if (!batch) return;
    setBatchPreview(null);
    setBatchChecked(false);
    const result = await mutate<BatchPreview>(
      `batches/${batch.batch.id}/quote`,
      {},
      "批次模拟报价已生成，请核对分币种金额和费用。",
    );
    if (result) {
      setBatchPreview(result);
      setNow(Date.now());
    }
  }
  async function submitBatch() {
    if (
      !batch ||
      !batchPreview ||
      !batchChecked ||
      batchRemaining === 0 ||
      !batchEnough
    )
      return;
    const result = await mutate<BatchResult>(
      `batches/${batch.batch.id}/submit`,
      {
        fundingSource: "wallet",
        quoteIds: batchPreview.quotes.map((q) => q.id),
      },
      "有效行已创建结汇订单并冻结模拟余额，可逐笔追踪出款与回单。",
    );
    if (result) {
      setBatch(result);
      setBatchChecked(false);
      setBatchPreview(null);
    }
  }
  function addRecipient() {
    openCommand({
      title: "手动新增模拟收款账户",
      description:
        "保存后即可用于单笔或批量结汇，无需人工审核。系统仅检查必填项、账户尾号格式和地区币种匹配，不验证账户归属或银行信息。演示中请只填写虚构资料。",
      path: "beneficiaries",
      base: {
        customerId,
        country: market === "CNY" ? "CN" : "US",
        currency: market,
        accountToken: "mock-vault-" + uid(),
      },
      fields: [
        { key: "name", label: "虚构收款人名称", value: "MOCK 新收款人" },
        {
          key: "accountMasked",
          label: "虚构账户尾号（例如 **** 8888）",
          value: "**** 8888",
        },
      ],
      button: "保存并使用",
      success: "收款账户已保存，可立即用于结汇；未进行真实银行账户验证。",
    });
  }
  function openTopup(currency: string) {
    if (workspace) {setError("账号内测的充值渠道尚未开放"); return;}
    openCommand({
      title: "模拟充值 " + currency,
      description:
        "仅在当前演示账户记账，不连接区块链或托管服务，不提供真实地址。请勿转入任何真实资金。重复提交同一请求不会重复入账。",
      path: "wallet/deposits",
      base: { customerId, currency, idempotencyKey: "topup_" + uid() },
      fields: [
        {
          key: "amount",
          label: "模拟充值数量（最多 6 位小数）",
          value: "20000.00",
        },
      ],
      button: "确认模拟充值",
      success: "模拟余额已入账，可继续结汇。原草稿保留，报价将重新获取。",
    });
  }
  function goTopup() {
    setResumeDraft(true);
    setQuote(null);
    setChecked(false);
    setStep(1);
    go("wallet");
  }
  function resumeExchange() {
    setResumeDraft(false);
    setStep(1);
    setQuote(null);
    setChecked(false);
    setQuoteVersion((v) => v + 1);
    go("payment");
  }
  const evidence = (value: string): Field => ({
    key: "evidence",
    label: "MOCK 核验依据（仅虚构资料）",
    value,
    type: "textarea",
  });
  const reference = (value: string): Field => ({
    key: "providerReference",
    label: "模拟渠道参考号（请手动填写 MOCK- 开头）",
    value,
  });
  function resetSession() {
    if (workspace || !canResetDemoSession(actor, health?.persistence)) return;
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
    if (workspace) return;
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
        (page !== "workbench" || matchesMerchantQueue(o, merchantQueue)) &&
        (page === "workbench" ||
          filter === "all" ||
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
            {page === "workbench" ? (
              <strong>当前工作队列</strong>
            ) : (
              [
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
              ))
            )}
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
                      <strong>{o.orderNumber ?? shortId(o.id)}</strong>
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
                      {o.receiptStatus === "none"
                        ? "未附回单（可选）"
                        : "已登记回单"}
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
                : workspace ? "账号内测的资金渠道尚未开放，订单仅用于沙箱记录。" : "可以先创建 MOCK 场景，由同一管理员验证完整流程。"}
            </Empty>
          )}
        </div>
      </div>
    );
  }
  async function downloadPrivateReceipt(id: string, fileName: string) {
    const blob = await request<Blob>(
      `receipts/${id}/download`,
      undefined,
      undefined,
      "blob",
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function downloadPublishedReceipt(id: string, fileName: string) {
    const blob = await request<Blob>(
      `published-receipts/${id}/download`,
      undefined,
      undefined,
      "blob",
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    if (o.fundingSource === "wallet")
      return (
        <>
          <div className="deposit-number">
            {money(o.quote.totalDeposit)} <span>{o.quote.sourceCurrency}</span>
          </div>
          <Note>
            {o.walletFundingStatus === "released"
              ? "这笔模拟冻结已释放回钱包，不再处理付款。"
              : o.walletFundingStatus === "consumed"
                ? "这笔模拟结汇余额已结算扣减，可查看付款与回单状态。"
                : "已从模拟钱包冻结本笔本金与费用，无需再次转币。结果待核实时保持冻结，避免重复支出。"}
          </Note>
          <div className="demo-address">
            <Lock size={19} />
            <strong>MOCK ONLY · 无真实托管或资金操作</strong>
          </div>
        </>
      );
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
          <h2>订单 {o.orderNumber ?? shortId(o.id)}</h2>
          <Badge>
            <Lock size={13} /> 报价快照已锁定
          </Badge>
        </div>
        <p className="record-id">系统 ID：{o.id}</p>
        {!admin && <div className={"customer-detail-state " + customerOrderState(o).tone}><strong>{customerOrderState(o).label}</strong><p>{customerOrderState(o).detail}</p></div>}
        {o.payoutProviderSnapshot && (
          <Note>
            出款方：{o.payoutProviderSnapshot.name} ·{" "}
            {o.payoutProviderSnapshot.scope === "official"
              ? "官方自营"
              : "模拟合作方"}
            ，按下单时配置锁定，与推广返佣伙伴无关。
          </Note>
        )}
        {o.paymentConfirmation && (
          <Note>
            {o.paymentConfirmation.referenceKind === "mock_internal"
              ? "MOCK 内部确认记录："
              : "人工登记的模拟付款："}
            {o.paymentConfirmation.internalRecordId ??
              o.paymentConfirmation.providerReference}{" "}
            ·{" "}
            {date(
              o.paymentConfirmation.confirmedAt ?? o.paymentConfirmation.paidAt,
            )}{" "}
            · {money(o.paymentConfirmation.actualAmount)}{" "}
            {o.quote.payoutCurrency}
            {o.paymentConfirmation.confirmedBy &&
              ` · 操作人 ${o.paymentConfirmation.confirmedBy}`}
            。
            {o.paymentConfirmation.referenceKind === "mock_internal"
              ? "仅记录模拟确认，未执行真实付款、未做外部核验，不代表银行流水或收款到账。"
              : "这不是银行返回的真实付款凭据。"}
            {o.paymentConfirmation.note &&
              ` 备注：${o.paymentConfirmation.note}`}
          </Note>
        )}
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
            <small>订单结果</small>
            <Badge
              status={
                o.completionStatus === "completed" ? "verified" : "pending"
              }
            >
              {o.completionStatus === "completed"
                ? "已完成"
                : o.completionStatus === "pending_review"
                  ? "历史记录待复核"
                  : "处理中"}
            </Badge>
          </div>
        </div>
        {o.depositStatus === "exception" && (
          <Note danger>
            入金进入异常队列。服务端阻止自动兑换与出款，须独立调查。
          </Note>
        )}
        <FeeRows quote={o.quote} />
        {!admin &&
          (o.depositStatus === "awaiting" || o.fundingSource === "wallet") &&
          fundingPanel(o)}
        {!admin &&
          o.fundingSource === "wallet" &&
          o.walletFundingStatus === "reserved" &&
          o.payoutStatus === "draft" &&
          o.conversionStatus === "pending" && (
            <button
              className="button outline"
              disabled={locked}
              onClick={() =>
                openCommand({
                  title: "取消这笔模拟结汇？",
                  description:
                    "仅未处理的订单可取消。服务端确认安全后会解除冻结并退回模拟可用余额，结果未知的订单不能取消。",
                  path: `orders/${o.id}/cancel`,
                  base: {
                    reason: "MOCK: customer cancelled before processing",
                  },
                  button: "取消订单并释放余额",
                  success: "模拟订单已取消，冻结余额已释放。",
                })
              }
            >
              取消结汇并释放余额
            </button>
          )}
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
        {admin && !workspace ? (
          <>
            <div className="card-heading">
              <h3>付款处理</h3>
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
              labels={["确认资金", "核对与确认", "完成 · 回单可选"]}
            />
            <Note>
              官方自营模拟订单核对收款人、金额与执行方后即可确认，内部记录号由系统生成，备注选填。回单可后补；未知结果须先核实，不能重复确认。这里不执行真实付款。
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
                        openCommand(
                          canQuickMockConfirm(o)
                            ? {
                                title: "确认模拟付款",
                                description:
                                  "请核对以下信息。确认后系统生成唯一 MOCK 内部记录号，并记录操作人和时间，无需手填渠道号或核验内容。",
                                path: `orders/${o.id}/mock-payout`,
                                base: {
                                  idempotencyKey:
                                    "mock_" +
                                    o.id +
                                    "_" +
                                    (attempt?.id ?? "first"),
                                  expectedAmount: o.quote.payoutAmount,
                                  beneficiaryId: o.quote.beneficiaryId,
                                  payoutProviderId:
                                    o.payoutProviderSnapshot!.id,
                                },
                                review: [
                                  ["收款人", b?.name ?? o.quote.beneficiaryId],
                                  [
                                    "收款账户",
                                    b?.accountMasked ?? "仅模拟账户",
                                  ],
                                  [
                                    "模拟确认金额",
                                    `${money(o.quote.payoutAmount)} ${o.quote.payoutCurrency}`,
                                  ],
                                  ["执行方", o.payoutProviderSnapshot!.name],
                                ],
                                fields: [
                                  {
                                    key: "note",
                                    label: "备注（选填）",
                                    value: "",
                                    type: "textarea",
                                    required: false,
                                  },
                                ],
                                button: "核对无误，确认模拟付款",
                                success:
                                  "模拟确认已记录，内部编号已生成。未执行真实付款，回单可后补。",
                              }
                            : {
                                title: "确认已付款",
                                description:
                                  "请核对收款人和金额。此操作登记线下已完成的付款，不会发起转账。回单可以稍后补充。",
                                path: `orders/${o.id}/manual-payout`,
                                base: {
                                  idempotencyKey:
                                    "manual_" +
                                    o.id +
                                    "_" +
                                    (attempt?.id ?? "first"),
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
                                success:
                                  "付款结果已登记，可上传回单或稍后补充。",
                              },
                        )
                      }
                    >
                      {canQuickMockConfirm(o) ? "确认模拟付款" : "登记人工付款"}
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
              {o.payoutStatus === "sent" &&
                o.paymentConfirmation &&
                o.completionStatus !== "completed" && (
                  <button
                    className="button"
                    disabled={locked}
                    onClick={() =>
                      void mutate(
                        `orders/${o.id}/complete-recorded-payment`,
                        {},
                        "旧付款确认已同步为完成，佣金已按规则计提；没有再次付款。",
                      )
                    }
                  >
                    完成旧确认记录
                  </button>
                )}
              {o.payoutStatus === "sent" &&
                !o.reconciled &&
                o.completionStatus !== "completed" && (
                  <button
                    className="button outline"
                    disabled={locked}
                    onClick={() =>
                      openCommand({
                        title: "核对付款记录",
                        description:
                          o.paymentConfirmation?.referenceKind ===
                          "mock_internal"
                            ? "核对 MOCK 内部记录号和金额，必须填写人工核对说明。此记录不等于银行流水或到账验证。"
                            : "核对实际金额和渠道参考号。不一致会进入差异队列，必须填写人工核对说明。",
                        path: `orders/${o.id}/reconcile`,
                        base: {
                          referenceKind:
                            o.paymentConfirmation?.referenceKind ===
                            "mock_internal"
                              ? "mock_internal"
                              : "external",
                        },
                        fields: [
                          {
                            ...reference(attempt?.providerReference ?? ""),
                            label:
                              o.paymentConfirmation?.referenceKind ===
                              "mock_internal"
                                ? "MOCK 内部记录号（不代表银行流水）"
                                : "人工登记渠道参考号",
                          },
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
                {o.completionStatus === "completed"
                  ? "已确认完成，回单可稍后补充，无需重复核对"
                  : "历史付款已登记，尚待完成记录复核"}
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
                ? "回单可选，是否上传不影响订单完成"
                : o.receiptFileAvailable
                  ? "回单文件已上传，可下载查看"
                  : "已记录私有附件；公开给客户的副本另行人工确认"}
            </p>
          </div>
          {admin && (
            <button
              className="button outline"
              disabled={locked}
              onClick={() => {
                setReceiptOrderId(o.id);
                go("receipts");
              }}
            >
              <Files size={16} /> 管理多份回单
            </button>
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
        <PublishedReceipts
          key={actor + o.id}
          orderId={o.id}
          request={request}
          onDownload={downloadPublishedReceipt}
        />
        <p className="muted small">
          支持 PNG、JPEG、PDF 多附件，单个最大 2
          MiB。新原件默认仅管理员可见；识别仅用于人工匹配，不证明真实付款。文件未经恶意软件扫描。
          {workspace ? " 原件保存在服务器私有目录，客户只能下载管理员明确发布的脱敏副本。" : health?.accessMode === "public_demo" ? " 公开演示允许访客切换角色，只能使用虚构凭证。" : health?.persistence === "d1_mock"
            ? " 原件使用私有对象存储，记录按登录账号隔离。"
            : " 本地预览附件临时保存，会话失效后不可恢复。"}
        </p>
        <div className="ruleline" />
        <div className="card-heading">
          <h3>退款记录</h3>
          {maker &&
            o.fundingSource !== "wallet" &&
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
        {o.fundingSource === "wallet" && (
          <Note>
            钱包结汇仅支持未处理订单取消并释放冻结；已处理订单的退款流程尚未接入。结果未知或已换汇时不会自动释放余额。
          </Note>
        )}
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
    const p = data?.pricingCurrent;
    const rate = p?.rates.find(
      (r) => r.sourceCurrency === "USDT" && r.payoutCurrency === pricingMarket,
    );
    return (
      <div className="card pricing-panel">
        <div className="card-heading">
          <h2>当前客户汇率</h2>
          <Badge>MOCK</Badge>
        </div>
        {!p || !rate ? (
          <Empty title="当前身份无定价配置视图" />
        ) : (
          <>
            <label>
              适用市场
              <select
                value={pricingMarket}
                onChange={(e) => setPricingMarket(e.target.value)}
              >
                <option>CNY</option>
                <option>USD</option>
              </select>
            </label>
            <dl className="details">
              <div>
                <dt>1 USDT 客户汇率</dt>
                <dd>
                  {rate.customerRate} {rate.payoutCurrency}
                </dd>
              </div>
              <div>
                <dt>模拟参考基准</dt>
                <dd>{rate.referenceRate}</dd>
              </div>
              <div>
                <dt>默认服务费</dt>
                <dd>{money(p.serviceFee)} 来源币种</dd>
              </div>
              <div>
                <dt>通道手续费</dt>
                <dd>{money(p.channelFee)} 来源币种</dd>
              </div>
              <div>
                <dt>基准有效至</dt>
                <dd>{date(p.baseline.expiresAt)}</dd>
              </div>
              <div>
                <dt>配置版本</dt>
                <dd>{p.version}</dd>
              </div>
            </dl>
            <Note>
              {Date.parse(p.baseline.expiresAt) <= now
                ? "模拟基准已过期，新报价已停用，请更新并发布配置。"
                : "已锁定报价和订单保留原快照。客户专属服务费优先于默认费率。"}
            </Note>
            <button
              className="button outline full"
              onClick={() => go("pricing")}
            >
              管理汇率与费率
            </button>
          </>
        )}
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
            关联订单确认完成后，由服务端幂等计提；观察期、异常冻结和退款调整仍适用。
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
        ? "确认结汇"
        : step === 3
          ? "结汇已提交"
          : "结汇"
      : page === "certification" && role === "admin"
        ? "客户审核"
        : page === "recipients" && role === "admin"
          ? "收款账户"
          : titles[page];
  const storageLabel =
    health?.accessMode === "public_demo"
      ? "公开演示 · 访客共享虚构数据 · 勿输入真实资料"
      : health?.persistence === "d1_mock"
      ? "D1 持久演示记录 · 按已登录账户隔离 · 勿输入真实资料"
      : health?.persistence === "session-memory"
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
  const batchRemaining = batchPreview
    ? Math.max(0, Math.floor((Date.parse(batchPreview.expiresAt) - now) / 1000))
    : 0;
  const batchEnough =
    !!batchPreview &&
    batchPreview.totals.every((t) =>
      hasWalletFunds(
        walletBalances.find((w) => w.currency === t.currency)?.available,
        t.totalDeposit,
      ),
    );
  return (
    <div className={"app " + (role === "customer" ? "customer-workspace" : "")}>
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
              : actor === "company-demo"
                ? "商户工作台"
                : "个人工作台"}
        </div>
        <nav aria-label="主导航">
          {navs[role].filter(([p])=>p!=="routes"||!!workspace).map(([p, label, I]) => (
            <button
              key={p}
              title={label}
              className={
                page === p ||
                (p === "orders" && page === "detail") ||
                (p === "profile" &&
                  ["recipients", "certification"].includes(page))
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
          {!workspace && <a href="/workspace">业务账号内测</a>}
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
                  : "结汇"}
            </span>
            <b>/</b>
            {title}
          </div>
          <div className="top-actions">
            <span className="demo-badge">{workspace ? "账号内测 / 资金沙箱" : "MOCK · 无真实资金"}</span>
            {workspace ? <><span>{workspace.account.name}</span><button className="button text" onClick={() => void workspace.logout().catch(() => setError("退出失败，请重试"))}>退出</button></> : <>
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
            </select></>}
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
            <span className="connection-right">{workspace ? role === "admin" ? "管理员用户名登录 · 资金渠道关闭" : "账号已登录 · 客户邮箱未验证 · 资金渠道关闭" : "演示身份，无真实认证"}</span>
          </div>
          <details className="environment-details">
            <summary>{workspace ? "账号内测：会话8小时到期；资金沙箱，充值及付款关闭" : health?.persistence === "d1_mock" ? "演示数据已保存 · 存储与使用说明" : "临时演示数据 · 存储与使用说明"}</summary>
          {health?.accessMode === "public_demo" && <Note>当前入口免登录，不同访客共享同一份虚构数据。请勿输入真实客户、银行或钱包资料，也不要上传真实回单。业务账号内测使用独立入口和独立数据库。</Note>}
          {health?.persistence === "d1_mock" && health?.accessMode !== "public_demo" && (
            <Note>
              已登录账户的虚构演示历史保存于
              D1，跨会话和实例重启保留，账号之间隔离。总记录上限 1
              MiB；回单原件另存私有 R2，单份不超过 2
              MiB。容量满时保留原记录并停止新增。资金与订单仍为演示；仅上传有权处理的凭证，不上传密码、完整证件或支付卡资料。
            </Note>
          )}
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
          </details>
          <div className="page-heading">
            <div>
              <h1>{title}</h1>
              <p>{workspace && ["wallet", "payment", "profile"].includes(page) ? "独立账号内测：资金沙箱，充值及付款渠道尚未开放" : subtitles[page]}</p>
            </div>
            {role !== "customer" && <span className="date">{workspace ? "账号内测 / 资金沙箱" : "SERVER-BACKED DEMO"}</span>}
          </div>
          {support && !workspace && (
            <div className="card support">
              <h2>从这里开始体验</h2>
              <p>
                客户：钱包模拟充值 → 输入稳定币或目标法币金额 → 核对报价与收款人
                →
                冻结余额创建结汇订单。商户可批量导入校验。平台管理员：查看待处理订单
                → 核对后确认模拟付款 → 可选补充回单。推广伙伴：查看同一服务端产生的佣金与观察期。出款合作方由管理员独立管理。
              </p>
              <Note>
                只使用虚构资料。所有资金相关按钮仅调用 MOCK
                后端；不支持真实充值、换汇或付款。内存模式在 API
                重启后清空；会话内存最多保留 30 分钟，实例重启也会失效。D1
                模式保存虚构演示历史，浏览器会话到期不清空记录；公开演示访客共享数据，业务账号入口使用独立数据库。实际数据范围见页面连接状态。
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
          {support && workspace && <section className="card support"><h2>账号内测说明</h2><p>独立账号登录后仅显示所属客户或管理员工作台。新客户须等待管理员审核；资金渠道关闭，充值与付款不可用。回单原件仅管理员可见，客户只见明确发布给自己的副本。邮箱尚未验证，未接入 MFA 或找回密码。</p><button className="button text" onClick={() => setSupport(false)}>收起说明</button></section>}
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
              {page === "routes" && workspace && <RouteSettings admin={role==="admin"}/>}
              {page === "wallet" && role === "customer" && (
                <CustomerWallet fundsDisabled={!!workspace} key={actor} balances={walletBalances} deposits={data.walletDeposits ?? []} orders={orders} customerId={customerId} locked={locked} resumeDraft={resumeDraft} initialCurrency={asset}
                  onTopup={openTopup} onExchange={(currency) => { if (!resumeDraft) editForm(() => setAsset(currency)); resumeExchange(); }}
                  onOrder={(id) => { setSelected(id); go("detail"); }} />
              )}
              {page === "profile" && role === "customer" && (
                <>
                  <section className="profile-overview">
                    <div className="circle-icon">
                      <User size={27} />
                    </div>
                    <div>
                      <h2>{currentCustomer?.name}</h2>
                      <p>
                        {actor === "company-demo" ? "商户企业账户" : "个人账户"}{" "}
                        · {workspace ? "独立账号 · 未完成真实身份认证" : "仅演示身份，不构成真实认证"}
                      </p>
                    </div>
                    <Badge status={currentCustomer?.status} />
                  </section>
                  {profileTab === "home" ? <div className="profile-menu">
                    <button onClick={() => setProfileTab("recipients")}><span className="circle-icon"><Bank size={24}/></span><div><strong>收款人管理</strong><small>{beneficiaries.length} 个已保存账户 · 添加后即可使用</small></div><ArrowRight size={19}/></button>
                    <button onClick={() => setProfileTab("certification")}><span className="circle-icon"><User size={24}/></span><div><strong>账户资料</strong><small>查看{actor === "company-demo" ? "企业" : "个人"}演示资料与账户状态</small></div><ArrowRight size={19}/></button>
                    <button onClick={() => setProfileTab("security")}><span className="circle-icon"><Lock size={24}/></span><div><strong>安全与隐私</strong><small>登录、资料可见范围与演示边界</small></div><ArrowRight size={19}/></button>
                    <button onClick={() => setSupport(true)}><span className="circle-icon"><Question size={24}/></span><div><strong>帮助与演示说明</strong><small>资金、数据保存及回单使用说明</small></div><ArrowRight size={19}/></button>
                  </div> : <div className="profile-subheading"><button className="button text back-link" onClick={() => setProfileTab("home")}><ArrowLeft size={16}/> 返回用户中心</button><h2>{profileTab === "recipients" ? "收款人管理" : profileTab === "security" ? "安全与隐私" : "账户资料"}</h2></div>}
                  {profileTab === "security" && <section className="card security-summary"><h3>账户与数据保护</h3><p>{workspace ? "当前使用独立密码账号与安全会话。邮箱尚未验证，未接入 MFA 或找回密码；充值与付款关闭。" : "当前入口用于虚构数据演示，个人、商户和管理员均为可切换的演示角色，不是独立登录账号；数据范围以上方连接说明为准。"}</p><ul><li>业务账号入口按客户隔离；公开演示访客共享虚构数据，不应录入真实资料。</li><li>收款账户仅保存掩码资料，保存不代表真实身份或银行归属验证。</li><li>本演示不提供密码修改、双重验证设置或真实资金操作，请勿输入密码、完整证件或支付卡资料。</li></ul></section>}
                  {profileTab === "recipients" && (
                    <div className="profile-add">
                      <label>
                        新增账户地区
                        <select
                          aria-label="新增账户地区"
                          value={market}
                          onChange={(e) =>
                            editForm(() => setMarket(e.target.value))
                          }
                        >
                          <option value="CNY">中国大陆 · CNY</option>
                          <option value="USD">美国 · USD</option>
                        </select>
                      </label>
                      <button
                        className="button"
                        onClick={addRecipient}
                        disabled={locked}
                      >
                        <Plus size={17} />
                        新增模拟收款账户
                      </button>
                    </div>
                  )}
                </>
              )}
              {page === "payment" && role === "customer" && (
                <div className="exchange-flow">
                  {step === 1 && actor === "company-demo" && (
                    <div
                      className="tabs light exchange-mode"
                      aria-label="结汇方式"
                    >
                      <button
                        className={mode === "single" ? "active" : ""}
                        disabled={busy}
                        onClick={() => {
                          setMode("single");
                          setChecked(false);
                        }}
                      >
                        单笔结汇
                      </button>
                      <button
                        className={mode === "batch" ? "active" : ""}
                        disabled={busy}
                        onClick={() => {
                          setMode("batch");
                          setBatchChecked(false);
                        }}
                      >
                        批量结汇
                      </button>
                    </div>
                  )}
                  <Steps
                    active={
                      mode === "batch"
                        ? batchPreview
                          ? 3
                          : visibleBatch?.items.some(
                                (i) => i.status === "created",
                              ) &&
                              !visibleBatch.items.some(
                                (i) => i.status === "valid",
                              )
                            ? 4
                            : visibleBatch
                              ? 2
                              : 1
                        : step
                    }
                    labels={
                      mode === "batch"
                        ? ["上传表格", "校验结果", "核对报价", "提交完成"]
                        : ["填写结汇", "核对报价", "提交完成"]
                    }
                  />
                  {step === 1 && mode === "single" ? (
                    <div className="payment-layout exchange-single">
                      <section className="payment-form">
                        <h2>结汇金额</h2>
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
                            按到账金额
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
                            按支付总额
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
                                    ? "例如 100000"
                                    : "例如 50000"
                                  : "例如 1000"
                              }
                              value={enteredAmount}
                              disabled={busy}
                              onChange={(e) =>
                                editForm(() => setEnteredAmount(e.target.value))
                              }
                            />
                            <select
                              aria-label={
                                amountMode === "target_payout"
                                  ? "出款币种"
                                  : "稳定币"
                              }
                              value={
                                amountMode === "target_payout" ? market : asset
                              }
                              disabled={busy}
                              onChange={(e) =>
                                editForm(() => {
                                  if (amountMode === "target_payout") {
                                    setMarket(e.target.value);
                                    setBeneficiaryId("");
                                  } else setAsset(e.target.value);
                                })
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
                        <div className="exchange-currency-row">
                          {amountMode === "target_payout" ? (
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
                          ) : (
                            <label>
                              收款地区 / 币种
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
                          )}
                          <div className="exchange-available">
                            <span>钱包可用余额</span>
                            <strong>
                              {money(sourceBalance?.available ?? "0")} {asset}
                            </strong>
                            <button
                              className="link"
                              disabled={busy}
                              onClick={goTopup}
                            >
                              充值
                            </button>
                          </div>
                        </div>
                        <div className="card-heading recipient-heading">
                          <h2>收款人</h2>
                          <button
                            className="link"
                            disabled={busy}
                            onClick={() => {
                              go("profile");
                              setProfileTab("recipients");
                            }}
                          >
                            管理账户
                          </button>
                        </div>
                        <div className="recipient-select">
                          <div className="person-mark">
                            <User size={22} />
                          </div>
                          <div>
                            <select
                              aria-label="选择收款人"
                              value={chosenBeneficiaryId}
                              disabled={!usableBeneficiaries.length || busy}
                              onChange={(e) =>
                                editForm(() => setBeneficiaryId(e.target.value))
                              }
                            >
                              {!usableBeneficiaries.length && (
                                <option value="">暂无可用收款账户</option>
                              )}
                              {usableBeneficiaries.map((b) => (
                                <option key={b.id} value={b.id}>
                                  {b.name}
                                </option>
                              ))}
                            </select>
                            <p>
                              {recipient
                                ? `${recipient.accountMasked} · ${recipient.currency}`
                                : "添加收款账户后即可使用"}
                            </p>
                          </div>
                          <Bank size={22} className="teal" />
                        </div>
                        <div className="actions exchange-recipient-actions">
                          <button
                            className="link"
                            disabled={locked}
                            onClick={addRecipient}
                          >
                            <Plus size={16} />
                            新增收款账户
                          </button>
                          <span className="muted small">
                            保存即用 · 仅格式校验
                          </span>
                        </div>
                        <details className="exchange-details">
                          <summary>费用与演示规则</summary>
                          <p>
                            {amountMode === "total_deposit"
                              ? "支付总额包含服务费与通道费，扣除费用后的本金用于兑换。"
                              : "按目标到账金额反算稳定币本金及费用；收款银行如另收费，以实际渠道规则为准。"}
                          </p>
                          <p>
                            报价由服务端计算。仅使用 MOCK
                            网络与虚构账户，不执行真实付款；收款账户保存不代表身份、账户归属或合规验证。
                          </p>
                          <p>
                            付款回单可后补，不阻塞付款。历史订单与回单可在“订单”查看。
                          </p>
                        </details>
                      </section>
                      <aside
                        className="quote-panel exchange-quote"
                        aria-label="本次报价"
                      >
                        <div className="card-heading">
                          <h2>本次报价</h2>
                          {quote ? (
                            <Badge status={remaining ? "valid" : "error"}>
                              {remaining
                                ? `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")} 有效`
                                : "已过期"}
                            </Badge>
                          ) : (
                            <span className="muted small">MOCK</span>
                          )}
                        </div>
                        <p className="quote-label">收款人预计到账</p>
                        <div className="quote-amount">
                          {quote
                            ? symbol(quote.payoutCurrency) +
                              money(quote.payoutAmount)
                            : "—"}
                          <span>{quote?.payoutCurrency ?? market}</span>
                        </div>
                        {quote ? (
                          <FeeRows quote={quote} />
                        ) : (
                          <div className="quote-placeholder">
                            <p>
                              {quoteBusy
                                ? "正在获取服务器报价…"
                                : "填写金额并选择可用收款人"}
                            </p>
                          </div>
                        )}
                        {quoteError && <Note danger>{quoteError}</Note>}
                        {quote && !enoughBalance && (
                          <Note danger>
                            余额不足，需 {money(quote.totalDeposit)}{" "}
                            {quote.sourceCurrency}。充值后草稿会保留。
                          </Note>
                        )}
                        <button
                          className="button full big"
                          disabled={
                            locked ||
                            quoteBusy ||
                            !enoughBalance ||
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
                          下一步，核对结汇 <ArrowRight size={20} />
                        </button>
                        {quote && remaining === 0 && (
                          <button
                            className="button outline full"
                            disabled={locked || quoteBusy}
                            onClick={() => setQuoteVersion((v) => v + 1)}
                          >
                            报价过期，重新获取
                          </button>
                        )}
                        {quoteError && (
                          <button
                            className="button text full"
                            disabled={locked || quoteBusy}
                            onClick={() => setQuoteVersion((v) => v + 1)}
                          >
                            重试报价
                          </button>
                        )}
                        {quote && !enoughBalance && (
                          <button
                            className="button outline full"
                            disabled={busy}
                            onClick={goTopup}
                          >
                            前往钱包充值 <ArrowRight size={17} />
                          </button>
                        )}
                        {currentCustomer?.status !== "approved" && (
                          <Note danger>
                            当前客户尚未通过审核，无法创建报价。
                          </Note>
                        )}
                        <p className="center muted small exchange-disclaimer">
                          下一步仍需确认，暂不冻结余额
                        </p>
                        <details className="exchange-details">
                          <summary>报价来源</summary>
                          <p>
                            {quote?.configVersion ?? "MOCK 报价源"} ·
                            样例费率，不构成实时市场报价。
                          </p>
                        </details>
                      </aside>
                    </div>
                  ) : step === 1 && mode === "batch" ? (
                    <section className="card exchange-batch">
                      {!visibleBatch ? (
                        <>
                          {currentCustomer?.kind === "company" && (
                            <MerchantBatchImport
                              customerId={customerId}
                              customerName={currentCustomer?.name ?? "当前商户"}
                              disabled={locked}
                              onImport={async (rows, clientBatchId) => {
                                const result = await mutate<BatchResult>(
                                  "batches/merchant",
                                  { customerId, clientBatchId, rows },
                                  "服务端逐行校验完成，请核对目标到账金额、有效行和错误行。",
                                );
                                if (result) {
                                  setBatch(result);
                                  setBatchChecked(false);
                                  setBatchPreview(null);
                                  setBatchKey(clientBatchId);
                                }
                                return !!result;
                              }}
                            />
                          )}
                          <details
                            className="legacy-batch-import"
                            open={
                              currentCustomer?.kind !== "company"
                                ? true
                                : undefined
                            }
                          >
                            <summary>兼容旧版收款账户 ID CSV</summary>
                            <div className="card-heading">
                              <h2>旧版本金 CSV</h2>
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
                              行、100KB，使用当前客户已保存的收款账户 ID。
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
                                    setBatchPreview(null);
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
                                  setBatchPreview(null);
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
                                  setBatchPreview(null);
                                  setBatchKey("");
                                }}
                              >
                                载入含错误样例
                              </button>
                            </div>
                          </details>
                        </>
                      ) : batchPreview ? (
                        <>
                          <div className="card-heading exchange-stage-heading">
                            <div>
                              <h2>核对批次报价</h2>
                              <p className="muted small">
                                {batchPreview.quotes.length} 笔有效行 ·{" "}
                                {visibleBatch.batch.clientBatchId}
                              </p>
                            </div>
                            <Badge status={batchRemaining ? "valid" : "error"}>
                              {batchRemaining
                                ? `${batchRemaining} 秒有效`
                                : "报价已过期"}
                            </Badge>
                          </div>
                          <div className="exchange-batch-totals">
                            {batchPreview.totals
                              .filter((t) =>
                                batchPreview.quotes.some(
                                  (q) => q.sourceCurrency === t.currency,
                                ),
                              )
                              .map((t) => (
                                <section
                                  className="exchange-currency-total"
                                  key={t.currency}
                                >
                                  <h3>{t.currency}</h3>
                                  <dl className="details">
                                    <div>
                                      <dt>兑换本金</dt>
                                      <dd>
                                        {money(t.sourceAmount)} {t.currency}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>服务费</dt>
                                      <dd>
                                        {money(t.serviceFee)} {t.currency}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>通道费</dt>
                                      <dd>
                                        {money(t.channelFee)} {t.currency}
                                      </dd>
                                    </div>
                                    <div className="divided">
                                      <dt>确认后冻结总额</dt>
                                      <dd>
                                        <strong>
                                          {money(t.totalDeposit)} {t.currency}
                                        </strong>
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>钱包可用余额</dt>
                                      <dd>
                                        {money(
                                          walletBalances.find(
                                            (w) => w.currency === t.currency,
                                          )?.available ?? "0",
                                        )}{" "}
                                        {t.currency}
                                      </dd>
                                    </div>
                                  </dl>
                                </section>
                              ))}
                          </div>
                          <details
                            className="exchange-details exchange-quote-lines"
                            open
                          >
                            <summary>
                              逐笔收款人、到账金额与费用 ·{" "}
                              {batchPreview.quotes.length} 笔
                            </summary>
                            <div className="table-scroll">
                              <table>
                                <thead>
                                  <tr>
                                    <th>参考号 / 收款人</th>
                                    <th>预计到账</th>
                                    <th>汇率</th>
                                    <th>费用</th>
                                    <th>支付总额</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {batchPreview.quotes.map((q) => (
                                    <tr key={q.id}>
                                      <td>
                                        <strong>{q.clientItemId}</strong>
                                        <small>
                                          {beneficiaries.find(
                                            (b) => b.id === q.beneficiaryId,
                                          )?.name ??
                                            visibleBatch.items.find(
                                              (i) => i.id === q.itemId,
                                            )?.recipientName ??
                                            "收款人"}{" "}
                                          ·{" "}
                                          {beneficiaries.find(
                                            (b) => b.id === q.beneficiaryId,
                                          )?.accountMasked ??
                                            visibleBatch.items.find(
                                              (i) => i.id === q.itemId,
                                            )?.accountMasked}
                                        </small>
                                      </td>
                                      <td>
                                        {money(q.payoutAmount)}{" "}
                                        {q.payoutCurrency}
                                      </td>
                                      <td>
                                        1 {q.sourceCurrency} = {q.customerRate}{" "}
                                        {q.payoutCurrency}
                                      </td>
                                      <td>
                                        <small>
                                          服务费 {money(q.serviceFee)}{" "}
                                          {q.sourceCurrency}
                                        </small>
                                        <small>
                                          通道费 {money(q.channelFee)}{" "}
                                          {q.sourceCurrency}
                                        </small>
                                      </td>
                                      <td>
                                        {money(q.totalDeposit)}{" "}
                                        {q.sourceCurrency}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </details>
                          {visibleBatch.items.some(
                            (i) => i.status === "error",
                          ) && (
                            <Note>
                              {
                                visibleBatch.items.filter(
                                  (i) => i.status === "error",
                                ).length
                              }{" "}
                              行校验未通过，不参与本次报价，也不会创建订单。
                            </Note>
                          )}
                          {!batchEnough && (
                            <Note danger>
                              部分币种余额不足，暂不能提交。前往钱包充值后可返回重新报价。
                            </Note>
                          )}
                          {batchRemaining === 0 && (
                            <Note danger>
                              报价已过期，请重新获取并核对后再确认。
                            </Note>
                          )}
                          <p className="exchange-freeze-note">
                            <Lock size={17} />
                            确认后冻结以上本金与费用。不同币种独立核算，未知付款结果保持冻结。
                          </p>
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              checked={batchChecked}
                              disabled={
                                locked || !batchEnough || !batchRemaining
                              }
                              onChange={(e) =>
                                setBatchChecked(e.target.checked)
                              }
                            />
                            我已核对有效行、每笔收款人、报价与费用
                          </label>
                          <div className="actions exchange-batch-actions">
                            <button
                              className="button"
                              disabled={
                                locked ||
                                !batchChecked ||
                                !batchEnough ||
                                !batchRemaining
                              }
                              onClick={() => void submitBatch()}
                            >
                              {busy ? "正在提交…" : "确认并冻结模拟余额"}
                              <ArrowRight size={18} />
                            </button>
                            <button
                              className="button outline"
                              disabled={locked}
                              onClick={() => void previewBatch()}
                            >
                              重新获取报价
                            </button>
                            {!batchEnough && (
                              <button
                                className="button outline"
                                disabled={busy}
                                onClick={() => {
                                  setBatchPreview(null);
                                  setBatchChecked(false);
                                  goTopup();
                                }}
                              >
                                前往钱包充值
                              </button>
                            )}
                            <button
                              className="button text"
                              disabled={busy}
                              onClick={() => {
                                setBatchPreview(null);
                                setBatchChecked(false);
                              }}
                            >
                              <ArrowLeft size={16} />
                              返回校验结果
                            </button>
                          </div>
                          <p className="muted small">
                            仅为 MOCK
                            模拟报价与付款，提交时服务端会再次检查余额和有效期。
                          </p>
                        </>
                      ) : visibleBatch.items.some(
                          (i) => i.status === "created",
                        ) &&
                        !visibleBatch.items.some(
                          (i) => i.status === "valid",
                        ) ? (
                        <div className="exchange-batch-success">
                          <div className="circle-icon">
                            <CheckCircle size={34} />
                          </div>
                          <h2>批次已提交</h2>
                          <p>
                            {
                              visibleBatch.items.filter(
                                (i) => i.status === "created",
                              ).length
                            }{" "}
                            笔订单已创建，对应模拟余额已冻结。
                          </p>
                          <p className="muted small">
                            {visibleBatch.batch.clientBatchId}
                          </p>
                          <Note>
                            提交不代表付款完成。处理进度、失败或待确认结果及回单，请在订单中查看。
                          </Note>
                          {visibleBatch.items.some(
                            (i) => i.status === "error",
                          ) && (
                            <details className="exchange-details">
                              <summary>
                                {
                                  visibleBatch.items.filter(
                                    (i) => i.status === "error",
                                  ).length
                                }{" "}
                                行未创建订单，查看原因
                              </summary>
                              {visibleBatch.items
                                .filter((i) => i.status === "error")
                                .map((item) => (
                                  <div className="batch-row" key={item.id}>
                                    <div>
                                      <strong>
                                        {item.clientItemId || "缺少参考号"}
                                      </strong>
                                      <small>
                                        {item.errors
                                          .map(batchErrorLabel)
                                          .join("；")}
                                      </small>
                                    </div>
                                  </div>
                                ))}
                              <button
                                className="button outline"
                                disabled={busy}
                                onClick={() => {
                                  setBatch(null);
                                  setBatchPreview(null);
                                  setBatchChecked(false);
                                  setBatchKey("");
                                }}
                              >
                                修改错误行并重新上传
                              </button>
                            </details>
                          )}
                          <div className="actions">
                            <button
                              className="button"
                              onClick={() => go("orders")}
                            >
                              前往订单查看 <ArrowRight size={18} />
                            </button>
                            <button
                              className="button outline"
                              disabled={busy}
                              onClick={() => {
                                setBatch(null);
                                setBatchPreview(null);
                                setBatchChecked(false);
                                setBatchKey("");
                                setBatchText("");
                              }}
                            >
                              创建新批次
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="card-heading exchange-stage-heading">
                            <div>
                              <h2>核对校验结果</h2>
                              <p className="muted small">
                                {visibleBatch.batch.clientBatchId}
                              </p>
                            </div>
                            <button
                              className="link"
                              disabled={busy}
                              onClick={() => {
                                setBatch(null);
                                setBatchPreview(null);
                                setBatchChecked(false);
                                setBatchKey("");
                              }}
                            >
                              <ArrowLeft size={16} />
                              更换文件 / 修改后重传
                            </button>
                          </div>
                          <div className="batch-statline exchange-validation-counts">
                            <span>共 {visibleBatch.items.length} 行</span>
                            <span className="teal">
                              通过{" "}
                              {
                                visibleBatch.items.filter(
                                  (i) => i.status === "valid",
                                ).length
                              }
                            </span>
                            <span
                              className={
                                visibleBatch.items.some(
                                  (i) => i.status === "error",
                                )
                                  ? "red"
                                  : ""
                              }
                            >
                              待修改{" "}
                              {
                                visibleBatch.items.filter(
                                  (i) => i.status === "error",
                                ).length
                              }
                            </span>
                            {visibleBatch.items.some(
                              (i) => i.status === "created",
                            ) && (
                              <button
                                className="link"
                                onClick={() => go("orders")}
                              >
                                已提交{" "}
                                {
                                  visibleBatch.items.filter(
                                    (i) => i.status === "created",
                                  ).length
                                }{" "}
                                笔，查看订单
                              </button>
                            )}
                          </div>
                          <div className="exchange-validation-list">
                            {visibleBatch.items.map((item, i) => (
                              <div className="batch-row" key={item.id}>
                                <span
                                  className={
                                    "line-number " +
                                    (item.status === "error" ? "error" : "")
                                  }
                                >
                                  {item.rowNumber ?? i + 1}
                                </span>
                                <div>
                                  <strong>
                                    {item.clientItemId || "缺少参考号"}
                                  </strong>
                                  <small>
                                    {item.errors
                                      .map(batchErrorLabel)
                                      .join("；") ||
                                      (item.orderId
                                        ? "订单 " + shortId(item.orderId)
                                        : item.targetAmount
                                          ? `${item.recipientName ?? "收款人"} · ${item.bankName ?? ""} · ${item.accountMasked ?? ""} · 目标到账 ${money(item.targetAmount)} ${item.targetCurrency}`
                                          : `${money(item.sourceAmount)} ${item.sourceCurrency} 本金`)}
                                  </small>
                                </div>
                                <Badge status={item.status}>
                                  {item.status === "created"
                                    ? "已创建订单"
                                    : undefined}
                                </Badge>
                              </div>
                            ))}
                          </div>
                          <p className="muted small">
                            仅通过校验的行进入报价。错误行可修改后重新上传，不会创建订单。
                          </p>
                          <div className="actions exchange-batch-actions">
                            <button
                              className="button"
                              disabled={
                                locked ||
                                !visibleBatch.items.some(
                                  (i) => i.status === "valid",
                                )
                              }
                              onClick={() => void previewBatch()}
                            >
                              下一步，获取批次报价 <ArrowRight size={18} />
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
                                    "payoutStatus",
                                    "completionStatus",
                                    "receiptStatus",
                                  ],
                                  ...visibleBatch.items.map((i) => [
                                    i.clientItemId,
                                    i.status,
                                    i.errors.map(batchErrorLabel).join("; "),
                                    i.orderId ?? "",
                                    orders.find((o) => o.id === i.orderId)
                                      ?.payoutStatus ?? "",
                                    orders.find((o) => o.id === i.orderId)
                                      ?.completionStatus ?? "",
                                    orders.find((o) => o.id === i.orderId)
                                      ?.receiptStatus ?? "",
                                  ]),
                                ])
                              }
                            >
                              <Download size={17} />
                              下载逐行结果
                            </button>
                          </div>
                        </>
                      )}
                    </section>
                  ) : step === 2 && quote ? (
                    <section className="exchange-confirm">
                      <div className="mobile-quote exchange-confirm-summary">
                        <div className="card-heading">
                          <p>收款人预计到账 · {quote.payoutCurrency}</p>
                          <Badge status={remaining ? "valid" : "error"}>
                            {remaining
                              ? `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")} 有效`
                              : "报价已过期"}
                          </Badge>
                        </div>
                        <strong>
                          {symbol(quote.payoutCurrency)}
                          {money(quote.payoutAmount)}
                        </strong>
                      </div>
                      <div className="card confirm-card">
                        <div className="card-heading">
                          <span className="muted">收款人</span>
                          <span className="success-text">
                            <Bank size={18} />
                            已保存 · 仅格式校验
                          </span>
                        </div>
                        <h2>
                          {beneficiaries.find(
                            (b) => b.id === quote.beneficiaryId,
                          )?.name ?? "收款人"}
                        </h2>
                        <p>
                          {
                            beneficiaries.find(
                              (b) => b.id === quote.beneficiaryId,
                            )?.accountMasked
                          }{" "}
                          ·{" "}
                          {quote.payoutCurrency === "CNY" ? "中国大陆" : "美国"}{" "}
                          · {quote.payoutCurrency}
                        </p>
                        <div className="ruleline" />
                        <FeeRows quote={quote} />
                        <div className="wallet-inline">
                          <span>钱包可用余额</span>
                          <strong>
                            {money(
                              walletBalances.find(
                                (w) => w.currency === quote.sourceCurrency,
                              )?.available ?? "0",
                            )}{" "}
                            {quote.sourceCurrency}
                          </strong>
                        </div>
                        <p className="exchange-freeze-note">
                          <Lock size={18} />
                          确认后冻结 {money(quote.totalDeposit)}{" "}
                          {quote.sourceCurrency}
                          （含本金与费用）。未知付款结果保持冻结，避免重复支出。
                        </p>
                        <details className="exchange-details">
                          <summary>报价与演示详情</summary>
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
                              <dt>报价版本</dt>
                              <dd>{quote.configVersion}</dd>
                            </div>
                            <div>
                              <dt>到期时间</dt>
                              <dd>{date(quote.expiresAt)}</dd>
                            </div>
                          </dl>
                          <p>
                            MOCK
                            模拟网络，无真实充值地址或付款。报价由服务端生成并在提交时再次核验有效期。
                          </p>
                        </details>
                        <label className="checkbox">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={busy}
                            onChange={(e) => setChecked(e.target.checked)}
                          />
                          我已核对模拟收款账户、费用与总额
                        </label>
                        {!enoughBalance && (
                          <>
                            <Note danger>
                              可用余额不足，请先充值。当前草稿会保留。
                            </Note>
                            <button
                              className="button outline full"
                              disabled={busy}
                              onClick={goTopup}
                            >
                              前往钱包
                            </button>
                          </>
                        )}
                        {remaining === 0 && (
                          <Note danger>报价已过期，请返回重新获取并核对。</Note>
                        )}
                        <button
                          className="button full big"
                          disabled={
                            locked ||
                            !checked ||
                            remaining === 0 ||
                            !enoughBalance
                          }
                          onClick={() => void createOrder()}
                        >
                          {busy ? "正在提交…" : "确认结汇并冻结模拟余额"}
                          <ArrowRight size={20} />
                        </button>
                        <div className="actions centered">
                          <button
                            className="button text"
                            disabled={busy}
                            onClick={() => {
                              setStep(1);
                              setQuote(null);
                              setChecked(false);
                            }}
                          >
                            <ArrowLeft size={16} />
                            返回修改 / 重新报价
                          </button>
                        </div>
                      </div>
                    </section>
                  ) : step === 3 && order && order.id === selected ? (
                    <section className="card exchange-order-success">
                      <div className="circle-icon">
                        <CheckCircle size={34} />
                      </div>
                      <h2>结汇订单已提交</h2>
                      <p>订单 {shortId(order.id)} · MOCK 模拟</p>
                      {fundingPanel(order)}
                      <div className="actions">
                        <button className="button" onClick={() => go("detail")}>
                          查看订单状态 <ArrowRight size={18} />
                        </button>
                        <button
                          className="button outline"
                          disabled={busy}
                          onClick={() => {
                            setStep(1);
                            setQuote(null);
                            setChecked(false);
                          }}
                        >
                          再创建一笔结汇
                        </button>
                        <button
                          className="button text"
                          onClick={() => go("orders")}
                        >
                          全部订单与回单
                        </button>
                      </div>
                    </section>
                  ) : (
                    <Empty title="请重新核对结汇信息">
                      <button
                        className="button"
                        disabled={busy}
                        onClick={() => {
                          setStep(1);
                          setQuote(null);
                          setChecked(false);
                        }}
                      >
                        返回填写结汇
                      </button>
                    </Empty>
                  )}
                </div>
              )}
              {(page === "recipients" ||
                (page === "profile" && profileTab === "recipients")) && (
                <>
                  <div className="section-actions">
                    <Note>
                      保存后即可用于结汇，无需人工审核。系统自动检查必填项、格式、地区和币种；不会核验真实账户归属。
                    </Note>
                    {maker && (
                      <button
                        className="button"
                        disabled={
                          locked ||
                          !customers.some((c) => c.status === "approved")
                        }
                        onClick={() =>
                          openCommand({
                            title: "新增模拟收款账户",
                            description:
                              "创建中国大陆 CNY 路线的虚构账户（尾号 8888）。保存后即可使用，无需人工审核，仅检查字段和格式；不收集或验证真实银行账号。",
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
                            button: "保存收款账户",
                            success: "收款账户已保存，即可用于结汇。",
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
                          <Badge
                            status={
                              recipientUsable(b.status) ? "valid" : "suspended"
                            }
                          >
                            {recipientUsable(b.status)
                              ? "已保存 · 可使用"
                              : "已停用"}
                          </Badge>
                        </div>
                        <h2>{b.name}</h2>
                        <p>{b.accountMasked}</p>
                        <span className="tag">
                          {b.country === "CN" ? "中国大陆" : "美国"} ·{" "}
                          {b.currency}
                        </span>
                        <p className="record-id">收款账户 ID · {b.id}</p>
                        <div className="ruleline" />
                        <div className="actions">
                          {role === "customer" && recipientUsable(b.status) && (
                            <button
                              className="button outline"
                              disabled={locked}
                              onClick={() => {
                                setMarket(b.currency);
                                setBeneficiaryId(b.id);
                                setMode("single");
                                setStep(1);
                                setQuote(null);
                                setChecked(false);
                                go("payment");
                              }}
                            >
                              用于结汇 <ArrowRight size={16} />
                            </button>
                          )}
                          <span className="muted small">
                            {recipientUsable(b.status)
                              ? "无需人工审核，未做真实账户验证"
                              : "账户已停用，无法用于新结汇"}
                          </span>
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
              {(page === "certification" ||
                (page === "profile" && profileTab === "certification")) && (
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
              {page === "orders" &&
                (role === "admin" ? (
                  <OrderHistory
                    orders={orders}
                    customers={customers}
                    beneficiaries={beneficiaries}
                    persistence={health?.persistence}
                    onOpen={(id) => {
                      setSelected(id);
                      go("detail");
                    }}
                  />
                ) : (
                  <CustomerOrders key={actor} data={data} request={request} onDownload={downloadPublishedReceipt}
                    onOpen={(id) => { setSelected(id); go("detail"); }}
                    onResumeBatch={(id) => {
                      const selectedBatch = data.batches?.find((b) => b.id === id && b.customerId === customerId);
                      if (!selectedBatch) return;
                      setBatch({batch:selectedBatch,items:data.batchItems?.filter((i) => i.batchId === id) ?? []});
                      setBatchPreview(null); setBatchChecked(false); setBatchKey(selectedBatch.clientBatchId);
                      setMode("batch"); setStep(1); setQuote(null); setChecked(false); go("payment");
                    }} />
                ))}
              {page === "overview" && (
                <OverviewPanel
                  orders={orders}
                  persistence={health?.persistence}
                  onNavigate={(next) => go(next as Page)}
                />
              )}
              {page === "directory" && (
                <CustomerDirectoryPanel
                  customers={customers}
                  beneficiaries={beneficiaries}
                  orders={orders}
                  onOpenOrder={(id) => {
                    setSelected(id);
                    go("detail");
                  }}
                />
              )}
              {page === "referrals" && (
                <ReferralPartnersPanel
                  customers={customers}
                  commissions={commissionRows}
                  settlements={settlementRows}
                />
              )}
              {page === "providers" && (
                <PayoutProvidersPanel
                  providers={data.payoutProviders ?? []}
                  busy={locked}
                  onSave={(input) =>
                    mutate(
                      "admin/payout-providers",
                      input,
                      "出款合作方配置已保存，新订单按新默认分配。历史归属保持不变。",
                    )
                  }
                />
              )}
              {page === "detail" && (
                <>
                  <button
                    className="button text back"
                    onClick={() => go("orders")}
                  >
                    <ArrowLeft size={16} />
                    返回订单记录
                  </button>
                  {orderDetail(role === "admin")}
                </>
              )}
              {page === "workbench" && (
                <>
                  <MerchantOverview
                    orders={orders}
                    selectedQueue={merchantQueue}
                    onSelectQueue={(queue) => {
                      setMerchantQueue(queue);
                      setFilter("all");
                    }}
                  />
                  <div className="workspace-actions">
                    <span className="muted small">
                      同一后端 · {orders.length} 笔订单 ·{" "}
                      {
                        orders.filter((o) => o.payoutStatus === "unknown")
                          .length
                      }{" "}
                      笔结果待核实
                    </span>
                    {maker && !workspace && (
                      <div className="workspace-controls">
                        <button
                          className="button outline"
                          disabled={locked}
                          onClick={seedScenario}
                        >
                          <Plus size={17} />
                          创建 MOCK 场景
                        </button>
                        {(!workspace && canResetDemoSession(actor, health?.persistence)) && (
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
                          官方自营模拟订单核对后即可确认，系统自动生成内部记录；回单可后补。未知结果先核实，禁止重复确认。
                        </p>
                        <Note>
                          所有操作受服务端控制。客户、商家和伙伴入口仅用于演示，不能替代正式登录。
                        </Note>
                      </div>
                    </aside>
                  </div>
                </>
              )}
              {page === "receipts" && role === "admin" && (
                <ReceiptLibrary
                  key={actor}
                  orders={orders}
                  request={receiptRequest}
                  onChanged={reload}
                  download={downloadPrivateReceipt}
                  initialOrderId={receiptOrderId}
                />
              )}
              {page === "pricing" && (
                <PricingSettingsPanel
                  current={data.pricingCurrent}
                  history={data.pricingHistory ?? []}
                  busy={locked}
                  persistence={health?.persistence}
                  onPreview={previewPricing}
                  onPublish={(input) =>
                    mutate(
                      "admin/pricing/publish",
                      input,
                      "费率版本已发布。新报价使用新配置，原报价和订单快照不变。",
                    )
                  }
                />
              )}
              {page === "reconciliation" && (
                <>
                  <div className="stat-grid">
                    <div className="card stat">
                      <div>
                        <span>历史待复核</span>
                        <strong>
                          {
                            orders.filter(
                              (o) =>
                                o.payoutStatus === "sent" &&
                                !o.reconciled &&
                                o.completionStatus !== "completed",
                            ).length
                          }
                        </strong>
                        <small>不含正常确认完成的订单</small>
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
                        <small>人工核对记录，不代表银行认证</small>
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
                            <p>单层推荐 · 完成后计提 · 服务端观察期</p>
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
                page === p ||
                (p === "orders" && page === "detail") ||
                (p === "profile" &&
                  ["recipients", "certification"].includes(page))
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
          {command.review && (
            <dl className="details">
              {command.review.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
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
                    required={field.required !== false}
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
                    required={field.required !== false}
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
                    required={field.required !== false}
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
