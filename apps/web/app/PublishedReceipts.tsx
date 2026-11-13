"use client";
import { useEffect, useState } from "react";
type Published = {
  id: string;
  fileName: string;
  size: number;
  contentType: string;
};
export default function PublishedReceipts({
  orderId,
  batchId,
  request,
  onDownload,
}: {
  orderId?: string;
  batchId?: string;
  request: <T>(path: string) => Promise<T>;
  onDownload: (id: string, fileName: string) => Promise<void>;
}) {
  const [items, setItems] = useState<Published[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setItems([]);
    setError("");
    void request<{ receipts: Published[] }>(
      batchId
        ? `batches/${batchId}/published-receipts`
        : `orders/${orderId}/published-receipts`,
    )
      .then((r) => {
        if (active) setItems(r.receipts);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "回单读取失败");
      });
    return () => {
      active = false;
    };
  }, [orderId, batchId, request]);
  return (
    <div className="published-receipts">
      {error && <p role="alert">{error}</p>}
      {items.length > 0 && (
        <>
          <strong>{batchId ? "本商户批次回单" : "付款回单"}</strong>
          <p className="muted small">
            {batchId
              ? "由平台发布的本批次回单，可能包含成功和失败明细。"
              : "由平台发布，仅限此订单。"}
            回单不代表系统已验证银行付款，订单状态以平台逐笔处理结果为准。
          </p>
          <div className="actions">
            {items.map((item, i) => (
              <button
                key={item.id}
                className="button outline"
                onClick={() =>
                  void onDownload(item.id, item.fileName).catch((e) =>
                    setError(e.message),
                  )
                }
              >
                下载回单 {i + 1} · {Math.ceil(item.size / 1024)} KiB
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
