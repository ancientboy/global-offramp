"use client";
import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
export default function PdfReceiptPreview({ url }: { url: string }) {
  const [zoom, setZoom] = useState(1);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(1),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null),
    host = useRef<HTMLDivElement>(null),
    render = useRef<{ cancel: () => void; promise: Promise<unknown> } | null>(
      null,
    );
  useEffect(() => {
    let active = true;
    let loading: { destroy: () => Promise<void> } | undefined;
    setDocument(null);
    setPage(1);
    setZoom(1);
    setError("");
    setReady(false);
    void (async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const base = "/vendor/pdfjs/v" + pdfjs.version + "/";
      pdfjs.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.mjs";
      pdfjs.GlobalWorkerOptions.rendererSrc = base + "pdf.renderer.min.mjs";
      const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
      if (!active) return;
      const task = pdfjs.getDocument({
        data,
        cMapUrl: base + "cmaps/",
        cMapPacked: true,
        standardFontDataUrl: base + "standard_fonts/",
        wasmUrl: base + "wasm/",
        iccUrl: base + "iccs/",
        useSystemFonts: true,
        canvasMaxAreaInBytes: 16_000_000,
      });
      loading = task;
      const doc = await task.promise;
      if (active) setDocument(doc);
      else await task.destroy();
    })().catch((e) => {
      if (active)
        setError(
          e.name === "PasswordException"
            ? "此 PDF 需要密码，请下载后打开。"
            : "PDF 暂时无法预览，可下载后查看。",
        );
    });
    return () => {
      active = false;
      render.current?.cancel();
      void loading?.destroy().catch(() => {});
    };
  }, [url]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let active = true;
    setReady(false);
    const previous = render.current;
    previous?.cancel();
    void (async () => {
      await previous?.promise.catch(() => {});
      const p = await document.getPage(page);
      if (!active || !canvas.current) return;
      const width = Math.max(240, host.current?.clientWidth ?? 320),
        base = p.getViewport({ scale: 1 }),
        scale =
          ((width * zoom) / base.width) *
          Math.min(2, window.devicePixelRatio || 1),
        viewport = p.getViewport({ scale });
      canvas.current.width = Math.ceil(viewport.width);
      canvas.current.height = Math.ceil(viewport.height);
      canvas.current.style.width = zoom === 1 ? "100%" : `${width * zoom}px`;
      const task = p.render({ canvas: canvas.current, viewport });
      render.current = task;
      await task.promise;
      if (active) setReady(true);
    })().catch((e) => {
      if (active && e.name !== "RenderingCancelledException")
        setError("PDF 暂时无法预览，可下载后查看。");
    });
    return () => {
      active = false;
      render.current?.cancel();
    };
  }, [document, page, zoom]);
  return (
    <div ref={host} className="pdf-receipt-preview">
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          {!ready && <p role="status">正在加载 PDF 预览…</p>}
          {document && (
            <div className="receipt-zoom-controls">
              <button
                className="button text"
                disabled={zoom === 1 || !ready}
                onClick={() => {
                  setReady(false);
                  setZoom((n) => Math.max(1, n - 0.5));
                }}
              >
                缩小
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button
                className="button text"
                disabled={zoom >= 3 || !ready}
                onClick={() => {
                  setReady(false);
                  setZoom((n) => Math.min(3, n + 0.5));
                }}
              >
                放大
              </button>
            </div>
          )}
          <div className="pdf-page-scroll">
            {" "}
            <canvas
              ref={canvas}
              role="img"
              aria-label="PDF 付款回单预览"
              title="付款回单预览"
              data-rendered={ready ? "true" : "false"}
              style={{ display: ready ? "block" : "none" }}
            />
          </div>
          {document && document.numPages > 1 && (
            <div className="receipt-page-controls">
              <button
                className="button outline"
                disabled={page === 1 || !ready}
                onClick={() => {
                  setReady(false);
                  setPage((n) => n - 1);
                }}
              >
                上一页
              </button>
              <span>
                {page} / {document.numPages}
              </span>
              <button
                className="button outline"
                disabled={page === document.numPages || !ready}
                onClick={() => {
                  setReady(false);
                  setPage((n) => n + 1);
                }}
              >
                下一页
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
