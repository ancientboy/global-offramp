import type JSZipType from "jszip";
import { MERCHANT_HEADERS, validateMerchantRow } from "../../../packages/core/src/merchant-import";
export type MerchantWorkbookRows = Record<string, unknown>[];
/** XLSX is read locally. Preserve native cell types so numeric account cells are rejected. */
export async function readMerchantWorkbook(data: ArrayBuffer): Promise<MerchantWorkbookRows> {
  if (data.byteLength > 2_000_000) throw new Error("文件最多2MB，请拆分为每批100笔以内");
  const declaredSizes = verifyWorkbookArchive(data);
  await verifyExpandedWorkbook(data, declaredSizes);
  const imported = await import("exceljs");
  const ExcelJS = imported.default ?? imported;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data);
  const sheet = workbook.getWorksheet("批量结汇") ?? workbook.worksheets[0];
  if (!sheet) throw new Error("工作簿没有数据表");
  const headers = sheet.getRow(1);
  if (headers.cellCount !== 7 || MERCHANT_HEADERS.some((header, i) => headers.getCell(i + 1).value !== header)) throw new Error("表头不匹配，请使用下载模板，保留原有7列且不要重复表头");
  if (sheet.rowCount > 101) throw new Error("最多100笔，请删除第102行以后的内容或拆分文件");
  const keys = ["name", "bankName", "accountNumber", "targetAmount", "targetCurrency", "sourceCurrency", "clientItemId"];
  const rows: MerchantWorkbookRows = [];
  for (let index = 2; index <= sheet.rowCount; index++) {
    const excelRow = sheet.getRow(index);
    if (!excelRow.hasValues) continue;
    if (excelRow.cellCount > 7) throw new Error(`第${index}行包含模板以外的数据列`);
    const row: Record<string, unknown> = { sourceRowNumber: index };
    for (let i = 0; i < keys.length; i++) {
      const value = excelRow.getCell(i + 1).value;
      row[keys[i]] = value === null ? "" : typeof value === "object" ? "=不支持公式或复杂单元格" : keys[i] === "targetAmount" && typeof value === "number" ? String(value) : value;
    }
    rows.push(row);
  }
  if (!rows.length) throw new Error("请填写至少一笔数据");
  return rows;
}
export function merchantRowPreview(raw: Record<string, unknown>, index: number) {
  const { row, errors } = validateMerchantRow(raw, index + 2);
  return { ...row, accountNumber: /^\d{8,34}$/.test(row.accountNumber) ? `**** ${row.accountNumber.slice(-4)}` : "格式错误", errors };
}

/** Bound archive metadata before the parser allocates decompression buffers. ZIP64 is unnecessary for a 100-row upload. */
export function verifyWorkbookArchive(data: ArrayBuffer) {
  const view = new DataView(data); const length = view.byteLength;
  const invalid = () => { throw new Error("Excel压缩结构无效或展开后过大，请重新保存为标准.xlsx文件"); };
  if (length < 22) return invalid();
  let end = -1;
  for (let i = length - 22; i >= Math.max(0, length - 65_557); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === length) { end = i; break; }
  if (end < 0) return invalid();
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || count !== view.getUint16(end + 8, true) || count > 256 || !count || offset + size !== end) return invalid();
  let cursor = offset, total = 0;
  const sizes = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) return invalid();
    const flags = view.getUint16(cursor + 8, true), compressed = view.getUint32(cursor + 20, true), uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true), local = view.getUint32(cursor + 42, true);
    if (cursor + 46 + nameLength + extraLength + commentLength > end) return invalid();
    const filename = new TextDecoder().decode(new Uint8Array(data, cursor + 46, nameLength));
    if (/vbaProject|externalLinks|embeddings|media\//i.test(filename)) throw new Error("模板不支持宏、外部链接、嵌入文件或图片");
    if (sizes.has(filename)) return invalid();
    sizes.set(filename, uncompressed);
    total += uncompressed;
    if ((flags & 1) || uncompressed > 5_000_000 || total > 15_000_000 || (uncompressed > 100_000 && uncompressed > compressed * 200) || local + 30 > offset || view.getUint32(local, true) !== 0x04034b50) return invalid();
    const localSize = view.getUint32(local + 22, true);
    if (localSize && localSize !== uncompressed) return invalid();
    if (local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true) + compressed > offset) return invalid();
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end) return invalid();
  return sizes;
}

/** Decompress as bounded chunks before ExcelJS; never trust only declared ZIP sizes. */
async function verifyExpandedWorkbook(data: ArrayBuffer, declared: Map<string, number>) {
  const imported = await import("jszip"); const JSZip = imported.default ?? imported;
  const archive = await JSZip.loadAsync(data); let total = 0;
  for (const entry of Object.values(archive.files)) {
    if (entry.dir) continue;
    let actual = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = (entry as unknown as { internalStream(type: "uint8array"): JSZipType.JSZipStreamHelper<Uint8Array> }).internalStream("uint8array");
      stream.on("data", chunk => {
        actual += chunk.length; total += chunk.length;
        if (actual > 5_000_000 || total > 15_000_000 || actual > (declared.get(entry.name) ?? -1)) {
          stream.pause(); reject(new Error("Excel实际展开数据超过限制，请拆分或重新保存文件"));
        }
      });
      stream.on("error", reject);
      stream.on("end", () => actual === declared.get(entry.name) ? resolve() : reject(new Error("Excel文件长度不一致，请重新保存")));
      stream.resume();
    });
  }
}
