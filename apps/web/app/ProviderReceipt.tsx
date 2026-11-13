"use client";
import PdfReceiptPreview from "./PdfReceiptPreview";
import { useEffect, useState } from "react";
export type ReceiptInfo = {
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
};
export default function ProviderReceipt({
  orderId,
  receipt,
  busy,
  onUpload,
  onExpired,
}: {
  orderId: string;
  receipt?: ReceiptInfo | null;
  busy: boolean;
  onUpload: (f: File) => Promise<void>;
  onExpired: () => void;
}) {
  const [url, setUrl] = useState(""),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  useEffect(() => {
    setUrl("");
    setError("");
    if (!receipt) return;
    const controller = new AbortController();
    let active = true,
      objectUrl = "";
    setLoading(true);
    fetch(`/workspace/api/provider/orders/${orderId}/receipt`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (r) => {
        if (r.status === 401) onExpired();
        if (!r.ok) throw Error("回单暂时无法加载，请重试。");
        const blob = await r.blob();
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e) => {
        if (active && e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [orderId, receipt?.sha256, version]);
  return (
    <section className="provider-receipt">
      <h3>付款回单</h3>
      {receipt ? (
        <>
          <p className="receipt-file-info">
            {receipt.fileName} · {Math.max(1, Math.ceil(receipt.size / 1024))}{" "}
            KB
          </p>
          {loading && <p role="status">正在加载回单…</p>}
          {error && (
            <div role="alert">
              <p>{error}</p>
              <button
                className="button text"
                onClick={() => setVersion((n) => n + 1)}
              >
                重新加载回单
              </button>
            </div>
          )}
          {url && (
            <>
              {receipt.contentType === "application/pdf" ? (
                <PdfReceiptPreview url={url} />
              ) : (
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="放大查看付款回单"
                >
                  <img
                    className="receipt-image-preview"
                    alt="付款回单预览"
                    src={url}
                  />
                </a>
              )}
              <div className="actions receipt-preview-actions">
                <a
                  className="button outline"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {receipt.contentType === "application/pdf"
                    ? "打开 PDF"
                    : "放大查看"}
                </a>
                <a
                  className="button text"
                  href={url}
                  download={receipt.fileName}
                >
                  下载回单
                </a>
              </div>
            </>
          )}
        </>
      ) : (
        <p className="muted small">暂无回单</p>
      )}
      <label className="button outline">
        {busy ? "正在处理并上传…" : receipt ? "更新回单" : "上传回单"}
        <input
          aria-label="上传付款回单"
          type="file"
          accept="image/png,image/jpeg,application/pdf"
          disabled={busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void onUpload(f);
          }}
        />
      </label>
      <p className="muted small">图片自动压缩后上传；PDF 最大 2 MB。</p>
    </section>
  );
}
