import { FIAT_CODES } from "./money";
/** No number coercion for account identifiers: already-lost digits cannot be recovered. */
export const MERCHANT_HEADERS = [
  "姓名",
  "银行",
  "银行卡号",
  "到账金额",
  "到账币种",
  "支付币种（选填）",
  "商户行号（选填）",
] as const;
export interface MerchantImportRow {
  sourceRowNumber?: number;
  name: string;
  bankName: string;
  accountNumber: string;
  targetAmount: string;
  targetCurrency: "CNY" | "USD" | "EUR" | "MXN" | "BRL" | "GBP";
  sourceCurrency: "USDT" | "USDC";
  clientItemId: string;
}
const keys = [
  "name",
  "bankName",
  "accountNumber",
  "targetAmount",
  "targetCurrency",
  "sourceCurrency",
  "clientItemId",
];
export function validateMerchantRow(raw: unknown, rowNumber: number) {
  const errors: string[] = [];
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  if (
    Object.keys(input).some((k) => !keys.includes(k) && k !== "sourceRowNumber")
  )
    errors.push("含未知字段；商户由当前页面统一指定");
  if (keys.some((k) => input[k] !== undefined && typeof input[k] !== "string"))
    errors.push("所有字段须为文本，金额请使用普通十进制格式");
  const str = (key: string) =>
    typeof input[key] === "string" ? (input[key] as string).trim() : "";
  if (
    input.sourceRowNumber !== undefined &&
    (!Number.isInteger(input.sourceRowNumber) ||
      (input.sourceRowNumber as number) < 2 ||
      (input.sourceRowNumber as number) > 101)
  )
    errors.push("表格行号须在2至101之间");
  const row: MerchantImportRow = {
    sourceRowNumber:
      typeof input.sourceRowNumber === "number" &&
      Number.isInteger(input.sourceRowNumber) &&
      input.sourceRowNumber >= 2 &&
      input.sourceRowNumber <= 101
        ? input.sourceRowNumber
        : rowNumber,
    name: str("name"),
    bankName: str("bankName"),
    accountNumber: str("accountNumber"),
    targetAmount: str("targetAmount"),
    targetCurrency: str("targetCurrency") as
      "CNY" | "USD" | "EUR" | "MXN" | "BRL" | "GBP",
    sourceCurrency: (str("sourceCurrency") || "USDT") as "USDT" | "USDC",
    clientItemId: str("clientItemId") || `row_${rowNumber}`,
  };
  if (!row.name || row.name.length > 100) errors.push("姓名必填，最多100字");
  if (!row.bankName || row.bankName.length > 100)
    errors.push("银行必填，最多100字");
  if (
    typeof input.accountNumber !== "string" ||
    !/^\d{8,34}$/.test(row.accountNumber)
  )
    errors.push(
      "卡号必须为8–34位文本数字；不接受数字单元格、科学计数法或公式，请从原始资料重新填写",
    );
  if (
    !/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(row.targetAmount) ||
    !/[1-9]/.test(row.targetAmount)
  )
    errors.push("到账金额须大于0，最多两位小数且不超过12位整数");
  if (!(FIAT_CODES as readonly string[]).includes(row.targetCurrency))
    errors.push("到账币种支持CNY、USD、EUR、MXN、BRL、GBP");
  if (!["USDT", "USDC"].includes(row.sourceCurrency))
    errors.push("支付币种仅支持USDT或USDC");
  if (!/^[a-zA-Z0-9_-]{1,50}$/.test(row.clientItemId))
    errors.push("商户行号限50位字母、数字、下划线或短横线");
  if (
    Object.values(input).some(
      (v) => typeof v === "string" && /^[\s\u0000-\u001f]*[=+@-]/.test(v),
    )
  )
    errors.push("不接受电子表格公式或公式前缀");
  // Do not retain untrusted formulas or unlimited input in batch/error exports.
  if (errors.length) {
    row.name = /^[\s\u0000-\u001f]*[=+@-]/.test(row.name)
      ? ""
      : row.name.slice(0, 100);
    row.bankName = /^[\s\u0000-\u001f]*[=+@-]/.test(row.bankName)
      ? ""
      : row.bankName.slice(0, 100);
    if (!/^[a-zA-Z0-9_-]{1,50}$/.test(row.clientItemId))
      row.clientItemId = `invalid_row_${rowNumber}`;
    if (!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(row.targetAmount))
      row.targetAmount = "";
    if (!(FIAT_CODES as readonly string[]).includes(row.targetCurrency))
      row.targetCurrency = "CNY";
    if (!["USDT", "USDC"].includes(row.sourceCurrency))
      row.sourceCurrency = "USDT";
  }
  return { row, errors };
}
