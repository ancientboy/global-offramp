"use client";
import { useEffect, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import SelectField from "./SelectField";
export type MarketStatus = {
  snapshot: null | {
    batchId: string;
    fetchedAt: string;
    fxDate: string;
    stablecoinUsd: { USDT: string; USDC: string };
    usdRates: { CNY: string };
    rates: {
      sourceCurrency: string;
      payoutCurrency: string;
      referenceRate: string;
    }[];
  };
  stale: boolean;
  expiresAt: string | null;
};
export default function MarketRatesPanel({
  authenticated = false,
  admin = false,
  onUpdated,
  onSnapshot,
}: {
  authenticated?: boolean;
  admin?: boolean;
  onUpdated?: () => void;
  onSnapshot?: (v: MarketStatus) => void;
}) {
  const [status, setStatus] = useState<MarketStatus | null>(null),
    [asset, setAsset] = useState("USDT"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const endpoint =
    "/workspace/api/" +
    (authenticated ? "market-rates" : "public-market-rates");
  async function load() {
    const r = await fetch(endpoint, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!r.ok) throw new Error("暂时无法更新参考汇率，请稍后重试。");
    const v = await r.json();
    setStatus(v);
    onSnapshot?.(v);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    const timer = setInterval(() => void load().catch(() => {}), 60000);
    return () => clearInterval(timer);
  }, [endpoint]);
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(endpoint + "/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
      if (!r.ok) throw new Error("参考汇率更新失败，请稍后重试。");
      const v = await r.json();
      setStatus(v);
      onSnapshot?.(v);
      onUpdated?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "更新失败");
    } finally {
      setBusy(false);
    }
  }
  const rows =
    status?.snapshot?.rates.filter((r) => r.sourceCurrency === asset) ?? [];
  return (
    <section className="market-reference-panel">
      <header>
        <div>
          <h3>市场参考汇率</h3>
          <p>自动获取，每 15 分钟更新</p>
        </div>
        <div className="market-reference-actions">
          <SelectField
            aria-label="参考汇率来源资产"
            value={asset}
            onChange={(e) => setAsset(e.target.value)}
          >
            <option value="USDT">USDT</option>
          </SelectField>
          {admin && (
            <button
              type="button"
              className="button outline"
              disabled={busy}
              onClick={() => void refresh()}
            >
              <ArrowsClockwise size={15} className={busy ? "spin" : ""} />
              {busy ? "更新中" : "刷新汇率"}
            </button>
          )}
        </div>
      </header>
      {error && (
        <p className="market-reference-error" role="alert">
          {error}
        </p>
      )}
      {rows.length ? (
        <div className="market-reference-grid">
          {rows.map((r) => (
            <div key={r.payoutCurrency}>
              <span>{r.payoutCurrency}</span>
              <strong>{r.referenceRate}</strong>
              <small>1 {asset}</small>
            </div>
          ))}
        </div>
      ) : (
        <p>正在获取参考汇率…</p>
      )}
      {status?.snapshot && (
        <footer>
          <span>法币参考价：{status.snapshot.fxDate} · ECB</span>
          <span>
            稳定币市场价：Kraken · 获取于{" "}
            {new Date(status.snapshot.fetchedAt).toLocaleTimeString("zh-CN", {
              hour12: false,
            })}
          </span>
          {status.stale && (
            <span className="market-reference-error">参考价待更新</span>
          )}
        </footer>
      )}
    </section>
  );
}
