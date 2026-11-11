"use client";
import { useEffect, useRef, useState } from "react";
import {
  merchantRowPreview,
  readMerchantWorkbook,
  type MerchantWorkbookRows,
} from "./merchant-workbook";

export function MerchantBatchImport({
  customerId,
  customerName,
  disabled,
  onImport,
}: {
  customerId: string;
  customerName?: string;
  disabled?: boolean;
  onImport: (
    rows: MerchantWorkbookRows,
    clientBatchId: string,
  ) => Promise<boolean>;
}) {
  const [rows, setRows] = useState<MerchantWorkbookRows>([]);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [imported, setImported] = useState(false);
  const key = useRef("");
  const generation = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    generation.current++;
    setLoading(false);
    setRows([]);
    setFileName("");
    setError("");
    setImported(false);
    key.current = "";
    if (input.current) input.current.value = "";
  }, [customerId]);
  const preview = rows.map(merchantRowPreview);
  const invalid = preview.filter((r) => r.errors.length).length;
  return (
    <section className="merchant-import-panel" aria-label="商户批量表格导入">
      <div className="section-heading">
        <div>
          <h3>上传批量结汇表格</h3>
          <p>
            本批次商户：<strong>{customerName || customerId}</strong>
          </p>
        </div>
        <a
          className="button outline"
          href="/templates/merchant-batch-template.xlsx"
          download="批量结汇模板.xlsx"
        >
          下载 Excel 模板
        </a>
      </div>
      <p className="muted">
        填写收款人、银行、文本格式卡号与目标到账金额，然后上传。
      </p>
      <label className="field">
        <span>选择填写后的 .xlsx 文件</span>
        <span className="muted small">
          最多 100 笔 / 2MB · 仅使用虚构演示资料
        </span>
        <input
          ref={input}
          type="file"
          accept=".xlsx"
          aria-label="选择批量结汇 Excel 文件"
          disabled={disabled || loading}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            const token = ++generation.current;
            setRows([]);
            setError("");
            setImported(false);
            key.current = "";
            if (!file) return;
            if (!/\.xlsx$/i.test(file.name)) {
              setError("请选择 .xlsx 文件；旧版 CSV 请使用下方兼容导入");
              return;
            }
            if (file.size > 2_000_000) {
              setError("文件最多 2MB");
              return;
            }
            setLoading(true);
            try {
              const parsed = await readMerchantWorkbook(
                await file.arrayBuffer(),
              );
              if (token !== generation.current) return;
              setRows(parsed);
              setFileName(file.name);
              key.current = `merchant_${crypto.randomUUID()}`;
            } catch (e) {
              if (token === generation.current)
                setError(
                  e instanceof Error
                    ? e.message
                    : "无法读取文件，请使用下载模板",
                );
            } finally {
              if (token === generation.current) setLoading(false);
            }
          }}
        />
      </label>
      {loading && <p role="status">正在读取或校验表格…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!!rows.length && (
        <>
          <div className="merchant-local-result">
            <strong>{fileName}</strong>
            <p>
              本地预检：{rows.length} 笔 · {rows.length - invalid} 笔通过 ·{" "}
              {invalid} 笔待修改
            </p>
          </div>
          <details className="exchange-details" open={invalid > 0}>
            <summary>查看本地预检明细</summary>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>行</th>
                    <th>姓名 / 银行</th>
                    <th>卡号尾号</th>
                    <th>预计到账</th>
                    <th>校验</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((row, i) => (
                    <tr key={i}>
                      <td>{row.sourceRowNumber}</td>
                      <td>
                        {row.name || "未填写"}
                        <small>{row.bankName || "未填写银行"}</small>
                      </td>
                      <td>{row.accountNumber}</td>
                      <td>
                        {row.targetAmount} {row.targetCurrency}
                      </td>
                      <td>
                        {row.errors.length ? row.errors.join("；") : "可导入"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <button
            type="button"
            className="button"
            disabled={disabled || loading || imported}
            onClick={async () => {
              setLoading(true);
              setError("");
              try {
                if (await onImport(rows, key.current)) {
                  setImported(true);
                  setRows([]);
                  if (input.current) input.current.value = "";
                }
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : "导入失败，可使用相同批次编号重试",
                );
              } finally {
                setLoading(false);
              }
            }}
          >
            下一步，提交服务端校验
          </button>
          <p className="muted">
            点击后才发送至模拟服务；此步骤不创建订单、不冻结余额。
          </p>
        </>
      )}
      {imported && <p role="status">已导入，正在显示服务端校验结果。</p>}
      <details className="exchange-details">
        <summary>填写要求与资料说明</summary>
        <p>
          卡号必须按文本填写，保留前导零；不接受数字、科学计数法或公式卡号。金额填写目标到账法币，服务费与通道费在报价时另列。
        </p>
        <p>
          错误行不会生成收款人或订单。有效行通过服务端校验后，仍需核对报价并确认提交。
        </p>
        <p>
          请勿上传真实资料。仅保存卡号末 4
          位与演示令牌，不保留完整卡号，不连接银行或执行真实付款。
        </p>
      </details>
    </section>
  );
}

export default MerchantBatchImport;
