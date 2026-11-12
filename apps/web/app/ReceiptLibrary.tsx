"use client";
import SelectField from "./SelectField";
import { useEffect, useRef, useState } from "react";
import type { Worker } from "tesseract.js";
import type { Order } from "./models";
import {
  parseReceiptText,
  parseReceiptRows,
  reliableRecognition,
  validateReceiptFile,
  type ReceiptFields,
} from "./receipt-recognition";
import "./receipt-library.css";
import { receiptContrastImage } from "./receipt-image";
type Receipt = {
  recognitionDigest?: string;
  scopeDigest: string;
  batchPublished?: { customerId: string; batchId: string };
  kind?: string;
  published?: { orderId: string };
  quarantine?: { reason: string; at: string; actorId: string };
  id: string;
  fileName: string;
  size: number;
  contentType: string;
  uploadedAt: string;
  orderIds: string[];
  recognition?:
    ReceiptFields | { fields: ReceiptFields; rows?: ReceiptFields[] };
};
type Candidate = { orderId: string; reasons: string[] };
type Job = {
  id: string;
  file: File;
  status: string;
  error?: string;
  receiptId?: string;
  fields?: ReceiptFields;
};
const labels: [keyof ReceiptFields, string][] = [
  ["sourceStatus", "原文状态"],
  ["reference", "结汇单号"],
  ["transactionReference", "交易订单号"],
  ["recipientName", "收款人"],
  ["accountTail", "账户尾号"],
  ["amount", "结汇金额"],
  ["currency", "结汇币种"],
  ["payoutAmount", "预计到账金额"],
  ["payoutCurrency", "预计到账币种"],
  ["initiatedAt", "发起时间（原文时区未提供）"],
  ["completedAt", "完成时间（原文时区未提供）"],
];
const base64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
export default function ReceiptLibrary({
  orders,
  request,
  download,
  onChanged,
  initialOrderId,
}: {
  orders: Order[];
  request: <T>(path: string, init?: RequestInit) => Promise<T>;
  download?: (id: string, fileName: string) => Promise<void>;
  onChanged?: () => void;
  initialOrderId?: string;
}) {
  const [dirty, setDirty] = useState(false);
  const [viewedDigest, setViewedDigest] = useState<string | undefined>();
  const [multiCustomer, setMultiCustomer] = useState(false),
    [rows, setRows] = useState<ReceiptFields[]>([]),
    [rowIndex, setRowIndex] = useState(0);
  const [receipts, setReceipts] = useState<Receipt[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [storage, setStorage] = useState("");
  const [selected, setSelected] = useState(""),
    [fields, setFields] = useState<ReceiptFields>({}),
    [candidates, setCandidates] = useState<Candidate[]>([]),
    [orderId, setOrderId] = useState(initialOrderId ?? ""),
    [reason, setReason] = useState(""),
    [matchStatus, setMatchStatus] = useState(""),
    [confirmed, setConfirmed] = useState(false),
    [saving, setSaving] = useState(false);
  const [targetBatchId, setTargetBatchId] = useState("");
  const [batchConfirmed, setBatchConfirmed] = useState(false);
  const [redacted, setRedacted] = useState(false),
    [singleCustomer, setSingleCustomer] = useState(false),
    [purpose, setPurpose] = useState("");
  const live = useRef(true),
    stopped = useRef(false),
    worker = useRef<Worker | null>(null),
    running = useRef(false);
  useEffect(() => {
    live.current = true;
    request<{ receipts: Receipt[]; storageMode: string }>("/api/receipts")
      .then((r) => {
        if (live.current) {
          setReceipts(r.receipts);
          setStorage(r.storageMode);
        }
      })
      .catch((e) => {
        if (live.current) setError(e.message);
      });
    return () => {
      live.current = false;
      stopped.current = true;
      void worker.current?.terminate();
      worker.current = null;
    };
  }, [request]);
  const post = <T,>(path: string, body: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) });
  const update = (id: string, patch: Partial<Job>) => {
    if (live.current)
      setJobs((old) => old.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  };
  const merge = (receipt: Receipt) => {
    if (live.current)
      setReceipts((old) => [
        receipt,
        ...old.filter((r) => r.id !== receipt.id),
      ]);
  };
  async function process(queue: Job[]) {
    if (running.current) return;
    running.current = true;
    stopped.current = false;
    setBusy(true);
    setError("");
    try {
      for (const job of queue) {
        if (stopped.current || !live.current) break;
        try {
          const invalid = validateReceiptFile(job.file);
          if (invalid) throw new Error(invalid);
          let id = job.receiptId;
          if (!id) {
            update(job.id, { status: "上传存储", error: "" });
            const data = await base64(job.file);
            if (stopped.current) break;
            const r = await post<{ receipts: Receipt[]; storageMode: string }>(
              "/api/receipts/upload",
              {
                files: [
                  {
                    fileName: job.file.name,
                    contentType: job.file.type,
                    dataBase64: data,
                  },
                ],
                kind: multiCustomer ? "batch" : "single",
              },
            );
            if (!live.current) break;
            id = r.receipts[0].id;
            merge(r.receipts[0]);
            setStorage(r.storageMode);
            update(job.id, { receiptId: id });
          }
          if (stopped.current) {
            update(job.id, { status: "已存储，识别已取消" });
            break;
          }
          if (job.file.type === "application/pdf") {
            update(job.id, { status: "已存储 · PDF 暂不识别" });
            continue;
          }
          update(job.id, { status: "本机识别中" });
          if (!worker.current) {
            const { createWorker, OEM, PSM } = await import("tesseract.js");
            const w = await createWorker(["chi_sim", "eng"], OEM.LSTM_ONLY, {
              workerPath: "/ocr/worker.min.js",
              corePath: "/ocr",
              langPath: "/ocr",
              workerBlobURL: false,
              cacheMethod: "none",
              logger: (m) => {
                if (m.status === "recognizing text")
                  update(job.id, {
                    status: `本机识别 ${Math.round(m.progress * 100)}%`,
                  });
              },
            });
            if (stopped.current || !live.current) {
              await w.terminate();
              break;
            }
            await w.setParameters({
              tessedit_pageseg_mode: PSM.SINGLE_BLOCK,
              thresholding_method: "2",
            } as Parameters<Worker["setParameters"]>[0]);
            worker.current = w;
          }
          const result = await worker.current.recognize(job.file);
          if (stopped.current || !live.current) break;
          let parsedRows = parseReceiptRows(
            result.data.text,
            result.data.confidence,
          );
          const parsed = parseReceiptText(
            result.data.text,
            result.data.confidence,
          );
          if (
            result.data.confidence < 75 &&
            !stopped.current &&
            worker.current
          ) {
            update(job.id, { status: "本机识别 · 增强图片对比" });
            const fallbackImage = await receiptContrastImage(job.file);
            const fallback = await worker.current.recognize(fallbackImage);
            fallbackImage.width = 0;
            fallbackImage.height = 0;
            const second = parseReceiptText(
              fallback.data.text,
              fallback.data.confidence,
            );
            // Only fill missing label-backed fields; conflicting evidence is cleared for manual entry.
            for (const key of Object.keys(second) as (keyof ReceiptFields)[]) {
              if (["engine", "confidence", "fieldConfidence"].includes(key))
                continue;
              if (parsed[key] === undefined) {
                (parsed as Record<string, unknown>)[key] = second[key];
                parsed.fieldConfidence![key] = fallback.data.confidence;
              } else if (parsed[key] !== second[key]) {
                delete parsed[key];
                delete parsed.fieldConfidence![key];
              }
            }
            const otherRows = parseReceiptRows(
              fallback.data.text,
              fallback.data.confidence,
            );
            if (otherRows.length > parsedRows.length) parsedRows = otherRows;
          }
          if (stopped.current || !live.current) break;
          update(job.id, { fields: parsed, status: "保存识别字段" });
          const r = await post<{ receipt: Receipt }>(
            `/api/receipts/${encodeURIComponent(id)}/recognition`,
            {
              fields: parsedRows.length ? {} : parsed,
              ...(parsedRows.length ? { rows: parsedRows } : {}),
            },
          );
          merge(r.receipt);
          update(job.id, {
            status: reliableRecognition(parsed)
              ? "待人工核对关联"
              : "低置信度 / 字段不完整 · 待人工核对",
          });
        } catch (e) {
          update(job.id, {
            status: stopped.current ? "已取消" : "失败，可重试",
            error: stopped.current
              ? ""
              : e instanceof Error
                ? e.message
                : "处理失败",
          });
        }
      }
    } finally {
      running.current = false;
      if (live.current) {
        setBusy(false);
        setJobs((old) =>
          old.map((j) =>
            ["排队中", "上传存储", "保存识别字段"].includes(j.status) ||
            j.status.startsWith("本机识别")
              ? { ...j, status: j.receiptId ? "已存储，识别已取消" : "已取消" }
              : j,
          ),
        );
        onChanged?.();
      }
    }
  }
  function choose(receipt: Receipt) {
    if (saving) return;
    setDirty(false);
    setBatchConfirmed(false);
    setTargetBatchId("");
    setRedacted(false);
    setSingleCustomer(false);
    setPurpose("");
    setViewedDigest(receipt.recognitionDigest);
    setSelected(receipt.id);
    const r = receipt.recognition;
    const savedRows = r && "fields" in r ? (r.rows ?? []) : [];
    setRows(savedRows);
    setRowIndex(0);
    setFields(savedRows[0] ?? (r && "fields" in r ? r.fields : (r ?? {})));
    setCandidates([]);
    setMatchStatus("");
    setOrderId(initialOrderId ?? "");
    setReason("");
    setConfirmed(false);
  }
  async function saveRecognition() {
    setSaving(true);
    setError("");
    try {
      const r = await post<{
        receipt: Receipt;
        candidates: Candidate[];
        matchStatus: string;
      }>(`/api/receipts/${encodeURIComponent(selected)}/recognition`, {
        fields: rows.length ? {} : fields,
        ...(rows.length
          ? {
              rows: rows.map((r, i) => (i === rowIndex ? fields : r)),
              selectedRowIndex: rowIndex,
            }
          : {}),
      });
      if (!live.current) return;
      merge(r.receipt);
      setViewedDigest(r.receipt.recognitionDigest);
      setBatchConfirmed(false);
      setSingleCustomer(false);
      setRedacted(false);
      setDirty(false);
      setCandidates(r.candidates);
      setMatchStatus(r.matchStatus);
      setConfirmed(false);
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      if (live.current) setSaving(false);
    }
  }
  async function link() {
    if (dirty) return;
    setSaving(true);
    setError("");
    try {
      const r = await post<Receipt | { receipt: Receipt }>(
        `/api/receipts/${encodeURIComponent(selected)}/link`,
        {
          orderId,
          reason,
          confirmed: true,
          expectedRecognitionDigest: viewedDigest,
          ...(rows.length ? { selectedRowIndex: rowIndex } : {}),
        },
      );
      if (!live.current) return;
      merge("receipt" in r ? r.receipt : r);
      setBatchConfirmed(false);
      setSingleCustomer(false);
      setRedacted(false);
      setConfirmed(false);
      onChanged?.();
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : "关联失败");
    } finally {
      if (live.current) setSaving(false);
    }
  }
  async function publishBatch() {
    if (!active || !batchTarget || dirty) return;
    setSaving(true);
    setError("");
    try {
      const r = await post<Receipt>(
        `/api/receipts/${encodeURIComponent(active.id)}/publish-batch`,
        {
          customerId: batchTarget.customerId,
          batchId: batchTarget.batchId,
          expectedScopeDigest: active.scopeDigest,
          confirmedSingleCustomer: singleCustomer,
          confirmedEntireBatch: batchConfirmed,
          confirmedNoOtherCustomerData: redacted,
          purpose,
        },
      );
      if (live.current) {
        merge(r);
        setBatchConfirmed(false);
        setSingleCustomer(false);
        setRedacted(false);
        onChanged?.();
      }
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : "发布失败");
    } finally {
      if (live.current) setSaving(false);
    }
  }
  async function publish() {
    setSaving(true);
    setError("");
    try {
      const activeReceipt = receipts.find((r) => r.id === selected);
      if (!activeReceipt) return;
      const r = await post<Receipt | { receipt: Receipt }>(
        `/api/receipts/${encodeURIComponent(selected)}/publish`,
        {
          orderId: activeReceipt.orderIds[0],
          confirmedSingleCustomer: singleCustomer,
          confirmedRedacted: redacted,
          purpose,
        },
      );
      if (live.current) {
        merge("receipt" in r ? r.receipt : r);
        setRedacted(false);
        setSingleCustomer(false);
        onChanged?.();
      }
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : "发布失败");
    } finally {
      if (live.current) setSaving(false);
    }
  }
  const active = receipts.find((r) => r.id === selected),
    sent = orders.filter((o) =>
      ["sent", "failed", "unknown"].includes(o.payoutStatus),
    );
  const batchOptions = [
    ...new Map(
      orders.filter((o) => o.batchId).map((o) => [o.batchId, o]),
    ).values(),
  ];
  const batchTarget = batchOptions.find((o) => o.batchId === targetBatchId);
  return (
    <section className="card receipt-library">
      <div className="card-heading">
        <div>
          <h2>回单库</h2>
          <p>批量收集 · 本机识别 · 人工关联</p>
        </div>
        <span className="receipt-private">仅管理员可见</span>
      </div>
      <div className="receipt-notice">
        识别仅提取回单文字，不验证银行真伪、收款结果或真实付款。CNH 结汇与 CNY
        预计到账分别记录。原始文件默认仅管理员可见；发布须另行核对商户及批次归属，确认不含其他商户资料。
      </div>
      <div className="receipt-drop">
        <strong>上传图片或 PDF</strong>
        <label className="receipt-confirm">
          <input
            type="checkbox"
            checked={multiCustomer}
            disabled={busy}
            onChange={(e) => setMultiCustomer(e.target.checked)}
          />
          这些回单包含多名收款人（核对同一商户批次后可单独授权发布）
        </label>
        <p>
          每批最多 10 个，每个 ≤2 MiB。图片在本机逐个识别，不发送至外部 OCR
          服务；PDF 仅存储。可给同一订单关联多份回单。
        </p>
        <input
          aria-label="选择回单文件"
          type="file"
          multiple
          accept="image/png,image/jpeg,application/pdf"
          disabled={busy}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length > 10) {
              setError("每批最多选择 10 个文件");
              return;
            }
            const next = files.map((file) => ({
              id: crypto.randomUUID(),
              file,
              status: "排队中",
            }));
            setJobs(next);
            void process(next);
          }}
        />
        {busy && (
          <button
            className="button outline"
            onClick={() => {
              stopped.current = true;
              void worker.current?.terminate();
              worker.current = null;
            }}
          >
            取消剩余识别
          </button>
        )}
      </div>
      <p className="receipt-small">
        存储模式：{storage || "读取中"}
        。取消不会删除已成功存储的文件；首次识别需加载本站中文 / 英文模型。
      </p>
      {error && (
        <p role="alert" className="receipt-error">
          {error}
        </p>
      )}
      {!!jobs.length && (
        <ul className="receipt-jobs" aria-live="polite">
          {jobs.map((j) => (
            <li key={j.id}>
              <span>{j.file.name}</span>
              <span>
                {j.status}
                {j.error && ` · ${j.error}`}
              </span>
              {!busy &&
                ["失败，可重试", "已取消", "已存储，识别已取消"].includes(
                  j.status,
                ) && <button onClick={() => void process([j])}>重试</button>}
            </li>
          ))}
        </ul>
      )}
      <div className="receipt-layout">
        <div className="receipt-list">
          <h3>已存储回单 ({receipts.length})</h3>
          {!receipts.length && <p>暂无回单，上传后会在这里保留。</p>}
          {receipts.map((r) => (
            <button
              className={`receipt-row ${selected === r.id ? "active" : ""}`}
              key={r.id}
              disabled={saving}
              onClick={() => choose(r)}
            >
              <strong>{r.fileName}</strong>
              <span>
                {Math.ceil(r.size / 1024)} KB ·{" "}
                {r.recognition ? "已提取字段" : "未识别"} · 已关联{" "}
                {r.orderIds.length} 单
              </span>
              <small>{new Date(r.uploadedAt).toLocaleString()}</small>
            </button>
          ))}
        </div>
        <div className="receipt-detail">
          {active ? (
            <>
              <div className="card-heading">
                <h3>核对回单与订单</h3>
                {download && (
                  <button
                    className="button outline"
                    onClick={() =>
                      void download(active.id, active.fileName).catch((e) =>
                        setError(e.message),
                      )
                    }
                  >
                    下载原件
                  </button>
                )}
              </div>
              <p>
                字段为 OCR 建议，可按原件修正。置信度：
                {fields.confidence ?? "未识别"}
                {fields.confidence !== undefined ? " / 100" : ""}
                。所有关联均须管理员确认；修改某行后，请重新确认该行与原订单的关联，其他未改动行仍有效。
              </p>
              <button
                className="button outline"
                disabled={saving}
                onClick={() => {
                  setDirty(true);
                  const updated = rows.length
                    ? rows.map((r, i) => (i === rowIndex ? fields : r))
                    : [fields];
                  setRows([...updated, {}]);
                  setRowIndex(updated.length);
                  setFields({});
                  setCandidates([]);
                  setMatchStatus("");
                  setConfirmed(false);
                  setOrderId("");
                }}
              >
                补录遗漏行
              </button>
              {rows.length > 0 && (
                <label className="receipt-order">
                  逐行核对（识别到 {rows.length} 行）
                  <SelectField
                    value={rowIndex}
                    disabled={saving}
                    onChange={(e) => {
                      const i = Number(e.target.value);
                      setRows((old) =>
                        old.map((r, n) => (n === rowIndex ? fields : r)),
                      );
                      setRowIndex(i);
                      setFields(rows[i]);
                      setCandidates([]);
                      setMatchStatus("");
                      setConfirmed(false);
                      setOrderId("");
                    }}
                  >
                    {rows.map((r, i) => (
                      <option key={i} value={i}>
                        第 {i + 1} 行 · {r.recipientName ?? "姓名待核对"} · 尾号{" "}
                        {r.accountTail ?? "未识别"} · {r.payoutAmount}{" "}
                        {r.payoutCurrency}
                      </option>
                    ))}
                  </SelectField>
                </label>
              )}
              <div className="receipt-fields">
                {labels.map(([key, label]) => (
                  <label key={key}>
                    {label}
                    <input
                      disabled={saving}
                      maxLength={key === "recipientName" ? 100 : 80}
                      value={String(fields[key] ?? "")}
                      onChange={(e) => {
                        setDirty(true);
                        setFields((old) => ({
                          ...old,
                          [key]: e.target.value || undefined,
                        }));
                        setCandidates([]);
                        setMatchStatus("");
                        setConfirmed(false);
                      }}
                    />
                  </label>
                ))}
              </div>
              <button
                className="button outline"
                disabled={saving}
                onClick={() => void saveRecognition()}
              >
                保存字段并查找候选
              </button>
              {matchStatus && (
                <p>
                  {(
                    {
                      candidate: "找到候选订单，仍需核对",
                      ambiguous: "多个候选，不能自动判断",
                      no_match: "没有可靠匹配，请人工选择",
                      duplicate_reference: "参考号重复，请排查重复回单",
                    } as Record<string, string>
                  )[matchStatus] ?? matchStatus}
                </p>
              )}
              {candidates.map((c) => (
                <p key={c.orderId}>
                  候选{" "}
                  {orders.find((o) => o.id === c.orderId)?.orderNumber ??
                    c.orderId}
                  ：{c.reasons.join("、")}
                </p>
              ))}
              <label className="receipt-order">
                关联已出款 / 失败 / 待确认订单（可选）
                <SelectField
                  value={orderId}
                  onChange={(e) => {
                    setOrderId(e.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="">请选择订单</option>
                  {sent.map((o) => (
                    <option
                      key={o.id}
                      value={o.id}
                      disabled={!!(active.published || active.batchPublished)}
                    >
                      {o.orderNumber ?? o.id} · {o.quote.payoutAmount}{" "}
                      {o.quote.payoutCurrency} ·{" "}
                      {o.payoutStatus === "sent"
                        ? "已出款"
                        : o.payoutStatus === "failed"
                          ? "失败"
                          : "待确认"}
                      {active.orderIds.includes(o.id)
                        ? " · 已关联，可重新核对"
                        : ""}
                    </option>
                  ))}
                </SelectField>
              </label>
              <label className="receipt-order">
                核对说明
                <input
                  maxLength={500}
                  value={reason}
                  placeholder="说明原件与订单的关联依据"
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <label className="receipt-confirm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                我已核对原件、收款人与订单；此操作仅关联凭证，不证明真实付款。
              </label>
              <button
                className="button"
                disabled={
                  saving ||
                  dirty ||
                  !confirmed ||
                  !orderId ||
                  !reason.trim() ||
                  !!(active.published || active.batchPublished)
                }
                onClick={() => void link()}
              >
                {dirty ? "请先保存修改字段" : "确认关联"}
              </button>
              {!active.published &&
                !active.batchPublished &&
                !active.quarantine &&
                batchOptions.length > 0 && (
                  <label className="receipt-order">
                    批量回单归属（逐行关联可选）
                    <SelectField
                      value={targetBatchId}
                      disabled={saving}
                      onChange={(e) => {
                        setTargetBatchId(e.target.value);
                        setBatchConfirmed(false);
                        setSingleCustomer(false);
                        setRedacted(false);
                      }}
                    >
                      <option value="">选择商户及实际提交批次</option>
                      {batchOptions.map((o) => (
                        <option key={o.batchId} value={o.batchId}>
                          {o.customerId} · {o.batchId}
                        </option>
                      ))}
                    </SelectField>
                  </label>
                )}
              {active.quarantine ? (
                <p role="alert" className="receipt-error">
                  回单发布范围发生变化，该文件已隔离并停止客户下载。请重新上传核对后的安全副本。
                </p>
              ) : active.published || active.batchPublished ? (
                <p>
                  已发布商户专属回单，不可再关联其他订单。识别内容不改变付款结果。
                </p>
              ) : (active.kind === "batch" || targetBatchId) &&
                batchOptions.length > 0 ? (
                <details className="receipt-publish">
                  <summary>发布同一商户的批量回单</summary>
                  <p>
                    选择实际提交批次并核对整份文件后，可向该商户分享原件或脱敏副本。PDF、失败及待确认回单均可分享；逐行识别和订单关联可选。已有跨商户或跨批次关联时禁止发布。
                  </p>
                  <label className="receipt-confirm">
                    <input
                      type="checkbox"
                      checked={singleCustomer}
                      onChange={(e) => setSingleCustomer(e.target.checked)}
                    />
                    已核对全部收款人均属于此商户
                  </label>
                  <label className="receipt-confirm">
                    <input
                      type="checkbox"
                      checked={batchConfirmed}
                      onChange={(e) => setBatchConfirmed(e.target.checked)}
                    />
                    已核对整份原件仅属于选定商户的此实际提交批次
                  </label>
                  <label className="receipt-confirm">
                    <input
                      type="checkbox"
                      checked={redacted}
                      onChange={(e) => setRedacted(e.target.checked)}
                    />
                    文件不含其他商户或无关资料，确认允许此商户下载整份文件
                  </label>
                  <label className="receipt-order">
                    发布用途
                    <input
                      maxLength={300}
                      value={purpose}
                      onChange={(e) => setPurpose(e.target.value)}
                    />
                  </label>
                  <button
                    className="button outline"
                    disabled={
                      saving ||
                      dirty ||
                      !singleCustomer ||
                      !batchTarget ||
                      !batchConfirmed ||
                      !redacted ||
                      purpose.trim().length < 3
                    }
                    onClick={() => void publishBatch()}
                  >
                    确认向该商户发布批量回单
                  </button>
                </details>
              ) : active.kind === "single" && active.orderIds.length === 1 ? (
                <details className="receipt-publish">
                  <summary>发布已脱敏的单客户副本</summary>
                  <p>
                    只可发布重新上传的裁剪 /
                    脱敏单客户文件。批量回单或包含其他客户资料的原件不得发布。
                  </p>
                  <label className="receipt-confirm">
                    <input
                      type="checkbox"
                      checked={singleCustomer}
                      onChange={(e) => setSingleCustomer(e.target.checked)}
                    />
                    确认文件仅含该订单客户信息
                  </label>
                  <label className="receipt-confirm">
                    <input
                      type="checkbox"
                      checked={redacted}
                      onChange={(e) => setRedacted(e.target.checked)}
                    />
                    确认已裁剪 / 脱敏，不含其他客户、完整账号或无关资料
                  </label>
                  <label className="receipt-order">
                    发布用途
                    <input
                      maxLength={500}
                      value={purpose}
                      onChange={(e) => setPurpose(e.target.value)}
                    />
                  </label>
                  <button
                    className="button outline"
                    disabled={
                      saving ||
                      dirty ||
                      !singleCustomer ||
                      !redacted ||
                      purpose.trim().length < 3
                    }
                    onClick={() => void publish()}
                  >
                    确认向该客户发布副本
                  </button>
                </details>
              ) : null}
              {active.orderIds.length > 0 && (
                <p>
                  已关联：
                  {active.orderIds
                    .map(
                      (id) =>
                        orders.find((o) => o.id === id)?.orderNumber ?? id,
                    )
                    .join("、")}
                </p>
              )}
            </>
          ) : (
            <p className="receipt-empty">
              选择一份回单，核对提取字段并人工关联订单。
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
