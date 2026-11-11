"use client";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Bank,
  ChartLineUp,
  CurrencyCircleDollar,
  Plus,
  Users,
} from "@phosphor-icons/react";
import { Badge, Empty, Note } from "./ui";
import {
  date,
  money,
  type Customer,
  type Beneficiary,
  type Commission,
  type Settlement,
} from "./models";
import {
  operatingMetrics,
  referralTotals,
  pricingDraft,
  pricingAdjustmentLabel,
  type AdminOrder,
  type PricingInput,
  type PricingVersion,
  type PayoutProvider,
  type ProviderInput,
  type FiatCurrency,
} from "./admin-models";
import "./admin-panels.css";

export function OverviewPanel({
  orders,
  onNavigate,
  persistence,
}: {
  persistence?: string;
  orders: AdminOrder[];
  onNavigate: (target: "orders" | "workbench") => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today),
    [to, setTo] = useState(today);
  const invalid = !from || !to || from > to;
  const m = operatingMetrics(orders, from, to);
  return (
    <section className="admin-panel">
      <header className="admin-heading">
        <div>
          <span className="admin-eyebrow">运营总览 · MOCK</span>
          <h2>业务动态，一目了然</h2>
          <p>按实际业务时间统计，每种币种独立展示。</p>
        </div>
        <button className="admin-btn" onClick={() => onNavigate("orders")}>
          全部订单 <ArrowRight size={16} />
        </button>
      </header>
      <div className="admin-range">
        <label>
          开始日期
          <input
            aria-label="开始日期"
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <span>至</span>
        <label>
          结束日期
          <input
            aria-label="结束日期"
            type="date"
            value={to}
            min={from}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <span className="admin-timezone">UTC · 包含起止日期</span>
        <button
          className="admin-btn"
          onClick={() => {
            setFrom(today);
            setTo(today);
          }}
        >
          今天
        </button>
      </div>
      {m.missingPaymentTimeCount > 0 && (
        <Note>
          <strong>
            {m.missingPaymentTimeCount} 笔已付款旧记录未登记付款时间。
          </strong>{" "}
          未登记付款时间的旧记录不计入付款 /
          费用时段统计；此数量来自全部订单，不按当前日期范围归属。
          <button className="admin-btn" onClick={() => onNavigate("orders")}>
            查看订单明细 <ArrowRight size={14} />
          </button>
        </Note>
      )}
      {invalid ? (
        <Note danger>请选择有效的日期范围。</Note>
      ) : (
        <>
          <div className="admin-metrics">
            <article>
              <ChartLineUp size={23} />
              <span>新增订单</span>
              <strong>
                {m.createdCount}
                <small>笔</small>
              </strong>
              <p>按订单创建时间 createdAt</p>
            </article>
            <article>
              <Bank size={23} />
              <span>已登记付款</span>
              <strong>
                {m.paidCount}
                <small>笔</small>
              </strong>
              <p>按付款登记时间 paidAt</p>
            </article>
            {m.payouts.map((p) => (
              <article key={p.currency}>
                <CurrencyCircleDollar size={23} />
                <span>已记录金额 · {p.currency}</span>
                <strong>{money(p.amount)}</strong>
                <p>模拟确认或人工登记金额，非银行到账验证</p>
              </article>
            ))}
          </div>
          <div className="admin-card">
            <div className="admin-card-heading">
              <div>
                <h3>已登记付款对应费用</h3>
                <p>按付款时间归属，使用订单锁定费用；不是利润或净收入。</p>
              </div>
              <Badge status="confirmed">按来源币种</Badge>
            </div>
            <div className="admin-fees">
              {m.fees.map((f) => (
                <div key={f.currency}>
                  <strong>{f.currency}</strong>
                  <dl>
                    <div>
                      <dt>平台服务费</dt>
                      <dd>{money(f.service)}</dd>
                    </div>
                    <div>
                      <dt>通道手续费</dt>
                      <dd>{money(f.channel)}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
      <div className="admin-card admin-cta">
        <div>
          <h3>开始处理运营待办</h3>
          <p>入金、付款、回单与对账，在工作台集中处理。</p>
        </div>
        <button
          className="admin-btn primary"
          onClick={() => onNavigate("workbench")}
        >
          进入工作台 <ArrowRight size={16} />
        </button>
      </div>
      <details className="admin-definition">
        <summary>统计口径与数据范围</summary>
        <p>
          新增订单按 createdAt；付款笔数、金额及费用仅纳入已付款且存在
          paymentConfirmation 的订单，按 paidAt
          统计，不使用创建时间代替付款时间。没有付款凭据的历史数据不纳入已付款统计。不同币种不相加，退款未冲减，费用为毛额。当前为
          MOCK 演示数据，非财务报表。
          {persistence !== "d1_mock"
            ? "未配置持久存储：仅当前会话内保存，会话失效可能丢失，最长约 30 分钟。"
            : "当前数据按已登录账户隔离保存；仍为模拟交易。"}
        </p>
      </details>
    </section>
  );
}

export function PricingSettingsPanel({
  current,
  history,
  busy,
  onPreview,
  onPublish,
  persistence,
}: {
  persistence?: string;
  current?: PricingVersion;
  history: PricingVersion[];
  busy: boolean;
  onPreview: (input: PricingInput) => Promise<PricingVersion | null>;
  onPublish: (input: PricingInput) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<PricingInput | null>(
    current ? pricingDraft(current) : null,
  );
  const [preview, setPreview] = useState<PricingVersion | null>(null),
    [previewKey, setPreviewKey] = useState("");
  const [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const requestEpoch = useRef(0),
    inFlight = useRef(false);
  useEffect(() => {
    requestEpoch.current += 1;
    setDraft(current ? pricingDraft(current) : null);
    setPreview(null);
  }, [current?.version]);
  useEffect(
    () => () => {
      requestEpoch.current += 1;
    },
    [],
  );
  if (!draft || !current)
    return <Empty title="暂无定价配置">请刷新数据后重试。</Empty>;
  const locked = busy || working;
  const change = (next: PricingInput) => {
    requestEpoch.current += 1;
    setDraft(next);
    setPreview(null);
    setError("");
  };
  const requestPreview = async () => {
    if (busy || inFlight.current) return;
    inFlight.current = true;
    const epoch = ++requestEpoch.current;
    setWorking(true);
    setError("");
    setPreview(null);
    const key = JSON.stringify(draft);
    try {
      const result = await onPreview(draft);
      if (result && epoch === requestEpoch.current) {
        setPreview(result);
        setPreviewKey(key);
      }
    } catch (e) {
      if (epoch === requestEpoch.current)
        setError(e instanceof Error ? e.message : "预览失败，请重试。");
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  };
  const publish = async () => {
    if (
      busy ||
      inFlight.current ||
      !preview ||
      previewKey !== JSON.stringify(draft)
    )
      return;
    inFlight.current = true;
    setWorking(true);
    setError("");
    try {
      const result = await onPublish(draft);
      if (result !== false && result !== null) setPreview(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "发布失败，请重试。");
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  };
  return (
    <section className="admin-panel">
      <header className="admin-heading">
        <div>
          <span className="admin-eyebrow">平台定价 · {current.version}</span>
          <h2>汇率与费用</h2>
          <p>先设定参考基准，再调整客户执行汇率。</p>
        </div>
        <Badge status="pending">MOCK 参考源</Badge>
      </header>
      <Note>
        当前为人工填写的模拟基准，不是银行实时汇率。发布只影响后续新报价，已锁定报价与订单保持原版本；最终可用性由服务端校验。
      </Note>
      <fieldset disabled={locked} className="admin-fieldset">
        <div className="admin-card">
          <h3>1. 模拟市场基准</h3>
          <p>
            稳定币 → USD → CNY 组合定价；USD 路线直接使用稳定币 / USD 基准。
          </p>
          <div className="admin-form-grid">
            {(["USDT_USD", "USDC_USD", "USD_CNY"] as const).map((key) => (
              <label key={key}>
                {key.replace("_", " / ")}
                <input
                  inputMode="decimal"
                  value={draft.baseline[key]}
                  onChange={(e) =>
                    change({
                      ...draft,
                      baseline: { ...draft.baseline, [key]: e.target.value },
                    })
                  }
                />
              </label>
            ))}
            <label>
              基准时间（ISO 8601 / UTC）
              <input
                value={draft.baseline.asOf}
                onChange={(e) =>
                  change({
                    ...draft,
                    baseline: { ...draft.baseline, asOf: e.target.value },
                  })
                }
              />
            </label>
            <label>
              基准过期时间（ISO 8601 / UTC）
              <input
                value={draft.baseline.expiresAt}
                onChange={(e) =>
                  change({
                    ...draft,
                    baseline: { ...draft.baseline, expiresAt: e.target.value },
                  })
                }
              />
            </label>
          </div>
        </div>
        <div className="admin-card">
          <h3>2. 客户执行汇率调整</h3>
          <p>
            固定点差：基准 ± 点差。比例调整：基准 ×（1 ±
            调整比例）。选择上调或下调，数值填写非负数；比例以小数填写，例如
            0.005 = 0.5%。
          </p>
          <div className="admin-route-grid">
            {(["CNY", "USD"] as const).map((currency) => (
              <div className="admin-route" key={currency}>
                <div className="admin-card-heading">
                  <strong>{currency} 出款</strong>
                  <label className="admin-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.routes[currency].enabled}
                      onChange={(e) =>
                        change({
                          ...draft,
                          routes: {
                            ...draft.routes,
                            [currency]: {
                              ...draft.routes[currency],
                              enabled: e.target.checked,
                            },
                          },
                        })
                      }
                    />
                    启用路线
                  </label>
                </div>
                <label>
                  调整方式
                  <select
                    value={draft.routes[currency].adjustmentMode}
                    onChange={(e) =>
                      change({
                        ...draft,
                        routes: {
                          ...draft.routes,
                          [currency]: {
                            ...draft.routes[currency],
                            adjustmentMode: e.target.value as
                              "fixed" | "percentage",
                          },
                        },
                      })
                    }
                  >
                    <option value="fixed">
                      固定点差（{currency} / 稳定币）
                    </option>
                    <option value="percentage">比例调整（小数比例）</option>
                  </select>
                </label>
                <label>
                  调整方向
                  <select
                    value={
                      draft.routes[currency].adjustmentDirection ?? "subtract"
                    }
                    onChange={(e) =>
                      change({
                        ...draft,
                        routes: {
                          ...draft.routes,
                          [currency]: {
                            ...draft.routes[currency],
                            adjustmentDirection: e.target.value as
                              "add" | "subtract",
                          },
                        },
                      })
                    }
                  >
                    <option value="subtract">下调 − 客户汇率降低</option>
                    <option value="add">上调 + 客户汇率提高</option>
                  </select>
                </label>
                <label>
                  调整数值（
                  {draft.routes[currency].adjustmentMode === "fixed"
                    ? `${currency} / 稳定币`
                    : "小数比例"}
                  ）
                  <input
                    inputMode="decimal"
                    value={draft.routes[currency].adjustment}
                    onChange={(e) =>
                      change({
                        ...draft,
                        routes: {
                          ...draft.routes,
                          [currency]: {
                            ...draft.routes[currency],
                            adjustment: e.target.value,
                          },
                        },
                      })
                    }
                  />
                </label>
                <p>
                  {pricingAdjustmentLabel(draft.routes[currency], currency)}
                </p>
              </div>
            ))}
          </div>
        </div>
        <div className="admin-card">
          <h3>3. 每笔订单费用</h3>
          <p>
            固定金额，以该笔订单来源币种 USDT 或 USDC
            收取。客户专属服务费优先于平台默认；实际收费以客户报价为准。
          </p>
          <div className="admin-form-grid">
            <label>
              平台服务费
              <input
                inputMode="decimal"
                value={draft.serviceFee}
                onChange={(e) =>
                  change({ ...draft, serviceFee: e.target.value })
                }
              />
            </label>
            <label>
              通道手续费
              <input
                inputMode="decimal"
                value={draft.channelFee}
                onChange={(e) =>
                  change({ ...draft, channelFee: e.target.value })
                }
              />
            </label>
          </div>
        </div>
      </fieldset>
      {error && <Note danger>{error}</Note>}
      <div className="admin-actions">
        <span>当前版本 {current.version} · 修改后须重新预览</span>
        <button
          className="admin-btn primary"
          disabled={locked}
          onClick={requestPreview}
        >
          {working ? "处理中…" : "预览客户汇率"}
        </button>
      </div>
      {preview && previewKey === JSON.stringify(draft) && (
        <div className="admin-card admin-preview">
          <div className="admin-card-heading">
            <div>
              <h3>待发布预览</h3>
              <p>以下由服务端计算，尚未生效。</p>
            </div>
            <Badge status="pending">等待确认发布</Badge>
          </div>
          <RateTable version={preview} />
          <p>
            服务费 {money(preview.serviceFee)} / 通道费{" "}
            {money(preview.channelFee)}（每笔，来源币种）
          </p>
          <button
            className="admin-btn primary"
            disabled={locked}
            onClick={publish}
          >
            确认发布新版本
          </button>
        </div>
      )}
      <div className="admin-card">
        <h3>定价版本历史</h3>
        <p>
          {persistence !== "d1_mock"
            ? "仅当前 MOCK 会话可见，不是持久审计记录。"
            : "按当前登录账户保存的模拟定价版本。"}
        </p>
        {history.length ? (
          <div className="admin-history">
            {[...history].reverse().map((v) => (
              <details key={v.version}>
                <summary>
                  <strong>{v.version}</strong>
                  <span>
                    {v.publishedAt ? date(v.publishedAt) : "初始配置"}
                  </span>
                </summary>
                <RateTable version={v} />
                <p>
                  基准：{date(v.baseline.asOf)} · 过期：
                  {date(v.baseline.expiresAt)}
                </p>
                <p>
                  服务费 {money(v.serviceFee)} · 通道费 {money(v.channelFee)}
                  （来源币种）
                </p>
              </details>
            ))}
          </div>
        ) : (
          <p>暂无历史版本。</p>
        )}
      </div>
    </section>
  );
}
function RateTable({ version }: { version: PricingVersion }) {
  return (
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead>
          <tr>
            <th>兑换方向</th>
            <th>参考基准</th>
            <th>客户执行汇率</th>
            <th>管理员调整</th>
            <th>路线</th>
          </tr>
        </thead>
        <tbody>
          {version.rates.map((r) => (
            <tr key={r.sourceCurrency + r.payoutCurrency}>
              <td>
                {r.sourceCurrency} → {r.payoutCurrency}
              </td>
              <td>{r.referenceRate}</td>
              <td>
                <strong>{r.customerRate}</strong>
              </td>
              <td>
                {pricingAdjustmentLabel(
                  version.routes[r.payoutCurrency as FiatCurrency],
                  r.payoutCurrency as FiatCurrency,
                )}
              </td>
              <td>
                {version.routes[r.payoutCurrency as FiatCurrency]?.enabled
                  ? "已启用"
                  : "已停用"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PayoutProvidersPanel({
  providers,
  busy,
  onSave,
}: {
  persistence?: string;
  providers: PayoutProvider[];
  busy: boolean;
  onSave: (input: ProviderInput) => Promise<unknown>;
}) {
  const [draft, setDraft] = useState<ProviderInput | null>(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const save = async () => {
    if (!draft) return;
    setWorking(true);
    setError("");
    try {
      const result = await onSave(draft);
      if (result !== false && result !== null) setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败，请重试。");
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="admin-panel">
      <header className="admin-heading">
        <div>
          <span className="admin-eyebrow">付款执行主体</span>
          <h2>出款服务商</h2>
          <p>管理官方与第三方模拟出款路线。</p>
        </div>
        <button
          className="admin-btn primary"
          disabled={busy}
          onClick={() => {
            setError("");
            setDraft({
              name: "",
              status: "active",
              scope: "third_party",
              routes: ["CNY"],
              isDefault: false,
            });
          }}
        >
          <Plus size={16} />
          新增服务商
        </button>
      </header>
      <Note>
        出款服务商负责付款执行，与邀请客户、获得返佣的渠道合作伙伴独立。此处不配置推荐返佣，也不会连接真实银行或支付通道。
      </Note>
      <div className="admin-provider-grid">
        {providers.map((p) => (
          <article className="admin-card" key={p.id}>
            <div className="admin-card-heading">
              <Bank size={25} />
              <Badge status={p.status === "active" ? "confirmed" : "suspended"}>
                {p.status === "active" ? "启用中" : "已停用"}
              </Badge>
            </div>
            <h3>{p.name}</h3>
            <p>
              {p.scope === "official" ? "官方服务商" : "第三方服务商"} ·{" "}
              {p.isDefault ? "默认出款" : "可选出款"}
            </p>
            <div className="admin-chips">
              {p.routes.map((r) => (
                <span key={r}>{r} 路线</span>
              ))}
            </div>
            <button
              className="admin-btn"
              disabled={busy}
              onClick={() => {
                setError("");
                setDraft({ ...p, routes: [...p.routes] });
              }}
            >
              管理服务商
            </button>
          </article>
        ))}
      </div>
      {draft && (
        <div className="admin-card admin-preview">
          <h3>{draft.id ? "编辑出款服务商" : "新增出款服务商"}</h3>
          <fieldset className="admin-fieldset" disabled={busy || working}>
            <div className="admin-form-grid">
              <label>
                显示名称
                <input
                  value={draft.name}
                  maxLength={80}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label>
                主体类型
                <select
                  value={draft.scope}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      scope: e.target.value as ProviderInput["scope"],
                    })
                  }
                >
                  <option value="official">官方</option>
                  <option value="third_party">第三方</option>
                </select>
              </label>
              <label>
                状态
                <select
                  value={draft.status}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      status: e.target.value as ProviderInput["status"],
                    })
                  }
                >
                  <option value="active">启用</option>
                  <option value="disabled">停用</option>
                </select>
              </label>
            </div>
            <div className="admin-checkboxes">
              {(["CNY", "USD"] as const).map((r) => (
                <label className="admin-checkbox" key={r}>
                  <input
                    type="checkbox"
                    checked={draft.routes.includes(r)}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        routes: e.target.checked
                          ? [...draft.routes, r]
                          : draft.routes.filter((v) => v !== r),
                      })
                    }
                  />
                  {r} 出款
                </label>
              ))}
              <label className="admin-checkbox">
                <input
                  type="checkbox"
                  checked={draft.isDefault}
                  onChange={(e) =>
                    setDraft({ ...draft, isDefault: e.target.checked })
                  }
                />
                设为默认服务商
              </label>
            </div>
          </fieldset>
          <p>更改仅用于后续路由选择，已有订单保留原服务商快照。</p>
          {error && <Note danger>{error}</Note>}
          <div className="admin-actions">
            <button
              className="admin-btn"
              disabled={busy || working}
              onClick={() => setDraft(null)}
            >
              取消
            </button>
            <button
              className="admin-btn primary"
              disabled={
                busy || working || !draft.name.trim() || !draft.routes.length
              }
              onClick={save}
            >
              {working ? "保存中…" : "保存服务商"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export function CustomerDirectoryPanel({
  customers,
  beneficiaries,
  orders,
  onOpenOrder,
}: {
  persistence?: string;
  customers: Customer[];
  beneficiaries: Beneficiary[];
  orders: AdminOrder[];
  onOpenOrder: (id: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [selected, setSelected] = useState<string | null>(null);
  const list = customers.filter((c) =>
    `${c.name} ${c.id}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const customer = customers.find((c) => c.id === selected);
  return (
    <section className="admin-panel">
      <header className="admin-heading">
        <div>
          <span className="admin-eyebrow">客户与商户</span>
          <h2>客户目录</h2>
          <p>查看客户状态、收款账户与关联订单。</p>
        </div>
        <Users size={28} />
      </header>
      <label className="admin-search">
        搜索客户名称或编号
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入名称或客户编号"
        />
      </label>
      <div className="admin-directory">
        <div className="admin-card">
          {list.length ? (
            list.map((c) => (
              <button
                className={`admin-customer ${selected === c.id ? "selected" : ""}`}
                key={c.id}
                onClick={() => setSelected(c.id)}
              >
                <span>
                  <strong>{c.name}</strong>
                  <small>
                    {c.kind === "company" ? "企业商户" : "个人客户"} · {c.id}
                  </small>
                </span>
                <Badge status={c.status}>
                  {c.status === "active" ? "正常" : undefined}
                </Badge>
              </button>
            ))
          ) : (
            <Empty title="没有匹配的客户" />
          )}
        </div>
        <div className="admin-card">
          {customer ? (
            <>
              <h3>{customer.name}</h3>
              <p>
                {customer.kind === "company" ? "企业商户" : "个人客户"} ·{" "}
                {customer.id}
              </p>
              <div className="note">
                <span>
                  {customer.serviceFeeOverride !== undefined ? (
                    <>
                      客户专属服务费：
                      <strong>{money(customer.serviceFeeOverride)}</strong>
                      （每笔，订单来源币种 USDT /
                      USDC）。优先于平台默认服务费，通道费仍按平台配置。
                    </>
                  ) : (
                    "平台默认服务费：未设置客户专属费用，实际收费以客户报价为准。"
                  )}
                </span>
              </div>
              <h4>收款账户</h4>
              {beneficiaries
                .filter((b) => b.customerId === customer.id)
                .map((b) => (
                  <div className="admin-directory-row" key={b.id}>
                    <span>
                      {b.name}
                      <small>
                        {b.accountMasked} · {b.country} / {b.currency}
                      </small>
                    </span>
                    <Badge status={b.status} />
                  </div>
                ))}
              {!beneficiaries.some((b) => b.customerId === customer.id) && (
                <p>尚未保存收款账户。</p>
              )}
              <h4>关联订单</h4>
              {orders
                .filter((o) => o.customerId === customer.id)
                .map((o) => (
                  <button
                    className="admin-customer"
                    key={o.id}
                    onClick={() => onOpenOrder(o.id)}
                  >
                    <span>
                      <strong>{o.orderNumber ?? o.clientOrderId}</strong>
                      <small>{date(o.createdAt)}</small>
                    </span>
                    <span>
                      {money(o.quote.payoutAmount)} {o.quote.payoutCurrency}
                      <ArrowRight size={15} />
                    </span>
                  </button>
                ))}
              {!orders.some((o) => o.customerId === customer.id) && (
                <p>暂无关联订单。</p>
              )}
            </>
          ) : (
            <Empty title="选择一位客户">在左侧查看客户或企业商户详情。</Empty>
          )}
        </div>
      </div>
    </section>
  );
}

export function ReferralPartnersPanel({
  customers,
  commissions,
  settlements,
}: {
  customers: (Customer & { partnerId?: string })[];
  commissions: (Commission & { partnerId?: string })[];
  settlements: Settlement[];
}) {
  const ids = [
    ...new Set(
      [...customers, ...commissions, ...settlements].flatMap((row) =>
        row.partnerId ? [row.partnerId] : [],
      ),
    ),
  ].sort();
  return (
    <section className="admin-panel">
      <header className="admin-heading">
        <div>
          <span className="admin-eyebrow">推广合作 · 只读目录</span>
          <h2>推广返佣伙伴</h2>
          <p>查看已有合作伙伴的客户关联与返佣记录。</p>
        </div>
        <Users size={28} />
      </header>
      <Note>
        推广返佣伙伴，不是出款合作方。此目录仅展示已有编号和业务记录，不创建合作关系或修改返佣规则。金额按币种分开，返佣记录与结算单不可相加视为收益。
      </Note>
      {!ids.length ? (
        <Empty title="暂无推广返佣伙伴">
          客户关联或返佣记录中出现伙伴编号后，会显示在这里。
        </Empty>
      ) : (
        <div className="admin-provider-grid">
          {ids.map((id) => {
            const related = customers.filter((c) => c.partnerId === id),
              ledger = commissions.filter((c) => c.partnerId === id),
              batches = settlements.filter((s) => s.partnerId === id);
            const commissionTotals = referralTotals(
              ledger.map((c) => ({ currency: c.currency, amount: c.value })),
            );
            const settlementTotals = referralTotals(
              batches.map((s) => ({ currency: s.currency, amount: s.amount })),
            );
            return (
              <article className="admin-card" key={id}>
                <div className="admin-card-heading">
                  <h3>{id}</h3>
                  <Badge>推广伙伴</Badge>
                </div>
                <p>
                  {related.length} 位关联客户 · {ledger.length} 条返佣记录 ·{" "}
                  {batches.length} 张结算单
                </p>
                <h4>关联客户</h4>
                {related.length ? (
                  related.map((c) => (
                    <div className="admin-directory-row" key={c.id}>
                      <span>
                        {c.name}
                        <small>
                          {c.id} ·{" "}
                          {c.kind === "company" ? "企业商户" : "个人客户"}
                        </small>
                      </span>
                      <Badge status={c.status}>
                        {c.status === "active" ? "正常" : undefined}
                      </Badge>
                    </div>
                  ))
                ) : (
                  <p>当前无可见关联客户。</p>
                )}
                <h4>返佣账本累计</h4>
                <p>包含各状态记录及负向调整，不代表可提取或已支付金额。</p>
                {commissionTotals.length ? (
                  commissionTotals.map((t) => (
                    <div className="admin-directory-row" key={t.currency}>
                      <span>{t.currency}</span>
                      <strong>{money(t.amount)}</strong>
                    </div>
                  ))
                ) : (
                  <p>暂无返佣记录。</p>
                )}
                <h4>结算单金额累计</h4>
                <p>包含各状态结算单，不代表已实际付款。</p>
                {settlementTotals.length ? (
                  settlementTotals.map((t) => (
                    <div className="admin-directory-row" key={t.currency}>
                      <span>{t.currency}</span>
                      <strong>{money(t.amount)}</strong>
                    </div>
                  ))
                ) : (
                  <p>暂无结算单。</p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
