"use client";
import SelectField from "./SelectField";
import MarketRatesPanel, { type MarketStatus } from "./MarketRatesPanel";
import { useEffect, useState } from "react";
import type {
  RouteDefinition,
  RecipientMethodDefinition,
} from "../../../packages/core/src/route-catalog";

type Draft = {
  referenceRate: string | null;
  serviceFee: string | null;
  channelFee: string | null;
  minPayout: string | null;
  maxPayout: string | null;
  providerName: string;
  processingNote: string;
};
type Row = RouteDefinition & {
  version: number;
  availableForQuotes?: boolean;
  draft?: Draft;
};
type Catalog = {
  routes: Row[];
  methods: Record<string, RecipientMethodDefinition>;
};
const markets: Record<string, string> = {
  CN: "中国",
  US: "美国",
  EURO_AREA: "欧元区",
  MX: "墨西哥",
  BR: "巴西",
  GB: "英国",
};
const names: Record<string, string> = {
  referenceRate: "市场参考汇率（每单位稳定币兑换法币）",
  serviceFee: "服务费（来源稳定币）",
  channelFee: "渠道费（来源稳定币）",
  minPayout: "最低出款额（法币）",
  maxPayout: "最高出款额（法币）",
  providerName: "线下出款合作方",
  processingNote: "处理时间与操作说明",
};
const empty: Draft = {
  referenceRate: null,
  serviceFee: null,
  channelFee: null,
  minPayout: null,
  maxPayout: null,
  providerName: "",
  processingNote: "",
};
const fields: Record<string, string> = {
  accountHolderName: "收款户名",
  bankName: "银行名称",
  accountNumber: "银行账号",
  accountType: "账户类型",
  abaRoutingNumber: "ABA 路由号",
  iban: "IBAN",
  clabe: "CLABE",
  bankCode: "银行代码",
  branchNumber: "支行代码",
  pixKeyType: "PIX 键类型",
  pixKey: "PIX 键",
  sortCode: "Sort code",
};
const errors: Record<string, string> = {
  DRAFT_VERSION_CONFLICT: "配置已被更新，请刷新后重试。",
  FORBIDDEN: "当前账号无权修改路线配置。",
  INVALID_INPUT:
    "请检查输入：金额使用十进制，最低额不能大于最高额，汇率须大于零。",
};
export default function RouteSettings({ admin }: { admin: boolean }) {
  const [market, setMarket] = useState<MarketStatus | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [selected, setSelected] = useState("USDT-CNY"),
    [values, setValues] = useState<Draft>(empty),
    [busy, setBusy] = useState(false);
  const row = catalog?.routes.find((r) => r.id === selected);
  const referenceRate = market?.stale
    ? null
    : (market?.snapshot?.rates.find(
        (r) =>
          r.sourceCurrency === row?.sourceAsset &&
          r.payoutCurrency === row?.targetCurrency,
      )?.referenceRate ?? null);
  async function load() {
    const r = await fetch("/workspace/api/routes", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (!r.ok) throw new Error("路线目录读取失败，请重新登录或稍后重试。");
    const c = (await r.json()) as Catalog;
    setCatalog(c);
    return c;
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    setValues(row?.draft ?? empty);
  }, [row]);
  async function save() {
    if (!row) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fetch(`/workspace/api/routes/${row.id}/draft`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...values,
          referenceRate,
          expectedVersion: row.version,
        }),
      });
      const v = await r.json();
      if (!r.ok) throw new Error(errors[v.error] ?? "保存失败，请稍后重试。");
      await load();
      setNotice("配置草稿已保存。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <div className="card-heading">
        <h2>{admin ? "人工代付路线配置" : "首批出款地区"}</h2>
        <span className="badge">人工代付</span>
      </div>
      <MarketRatesPanel authenticated admin={admin} onSnapshot={setMarket} />
      <p>
        支持方向：USDT / USDC →
        CNY、USD、EUR、MXN、BRL、GBP。首版由运营线下付款，系统管理记录与对账。
      </p>
      <p className="muted small">各地区的可用状态以路线配置为准。</p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!catalog ? (
        <p>正在读取路线…</p>
      ) : (
        <>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>地区</th>
                  <th>来源资产</th>
                  <th>出款币种</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {catalog.routes.map((r) => (
                  <tr key={r.id}>
                    <td>{markets[r.market]}</td>
                    <td>{r.sourceAsset}</td>
                    <td>{r.targetCurrency}</td>
                    <td>{r.availableForQuotes ? "可报价" : "待配置"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {admin && (
            <div style={{ marginTop: 24 }}>
              <label>
                选择配置路线
                <SelectField
                  value={selected}
                  disabled={busy}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setNotice("");
                    setError("");
                  }}
                >
                  {catalog.routes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {markets[r.market]} · {r.id}
                    </option>
                  ))}
                </SelectField>
              </label>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
                  gap: 16,
                  marginTop: 16,
                }}
              >
                {Object.keys(empty).map((key) => (
                  <label key={key}>
                    {names[key]}
                    <input
                      value={
                        key === "referenceRate"
                          ? (referenceRate ?? "")
                          : (values[key as keyof Draft] ?? "")
                      }
                      readOnly={key === "referenceRate"}
                      disabled={busy}
                      maxLength={key === "processingNote" ? 500 : 100}
                      inputMode={
                        key === "providerName" || key === "processingNote"
                          ? "text"
                          : "decimal"
                      }
                      onChange={(e) =>
                        setValues({
                          ...values,
                          [key]:
                            e.target.value === "" &&
                            key !== "providerName" &&
                            key !== "processingNote"
                              ? null
                              : e.target.value,
                        })
                      }
                    />
                  </label>
                ))}
              </div>
              <p className="muted small">
                草稿版本：{row?.version ?? 0}
                。留空表示尚未确定，不会代填实时汇率或费用。
              </p>
              <button
                className="button"
                disabled={busy || !row}
                onClick={() => void save()}
              >
                {busy ? "保存中…" : "保存配置草稿"}
              </button>
            </div>
          )}
          <details style={{ marginTop: 20 }}>
            <summary>各地区收款字段</summary>
            {Object.values(catalog.methods).map((m) => (
              <p key={m.id}>
                <strong>{m.label}</strong>：
                {m.fields.map((f) => fields[f.id] ?? f.label).join("、")}
              </p>
            ))}
            <p className="muted small">
              这里列出计划字段，不收集完整证件资料；后续按实际付款渠道核实要求。
            </p>
          </details>
        </>
      )}
    </section>
  );
}
