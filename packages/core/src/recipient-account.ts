import {
  RECIPIENT_METHODS,
  EURO_AREA_COUNTRIES,
  validateRecipientForm,
  type RecipientMethodId,
} from "./route-catalog";
export type AccountField = {
  id: string;
  label: string;
  required: boolean;
  options?: readonly string[];
  inputMode?: "text" | "numeric" | "email" | "tel";
  placeholder?: string;
};
export const ACCOUNT_METHODS: Record<string, readonly RecipientMethodId[]> = {
  CNY: ["CN_BANK_ACCOUNT"],
  USD: ["US_BANK_ACCOUNT"],
  EUR: ["EUR_IBAN"],
  MXN: ["MX_CLABE"],
  BRL: ["BR_BANK_ACCOUNT", "BR_PIX"],
  GBP: ["GB_LOCAL_ACCOUNT", "GB_IBAN"],
};
export const METHOD_NAMES: Record<RecipientMethodId, string> = {
  CN_BANK_ACCOUNT: "银行账户",
  US_BANK_ACCOUNT: "美国本地银行账户（ACH）",
  EUR_IBAN: "欧元银行账户（IBAN）",
  MX_CLABE: "银行账户（CLABE）",
  BR_BANK_ACCOUNT: "巴西银行账户",
  BR_PIX: "Pix",
  GB_LOCAL_ACCOUNT: "英国本地银行账户",
  GB_IBAN: "英国 IBAN",
};
export const FIELD_NAMES: Record<string, string> = {
  accountHolderName: "账户持有人姓名",
  bankName: "银行名称",
  accountNumber: "银行账号",
  accountType: "账户类型",
  abaRoutingNumber: "ACH 路由号（9位）",
  iban: "IBAN",
  clabe: "CLABE（18位）",
  bankCode: "银行代码（COMPE / ISPB）",
  branchNumber: "分行号（含校验位，如有）",
  pixKeyType: "Pix 密钥类型",
  pixKey: "Pix 密钥",
  sortCode: "Sort code（6位）",
  branchName: "开户支行",
  province: "开户省份",
  city: "城市",
  addressLine1: "收款人街道地址",
  state: "州（两位代码）",
  postalCode: "邮政编码",
  taxId: "CPF / CNPJ",
  bic: "BIC / SWIFT（选填）",
};
export const OPTION_NAMES: Record<string, string> = {
  checking: "活期账户",
  savings: "储蓄账户",
  payment: "支付账户",
  email: "邮箱",
  phone: "手机号（含国际区号）",
  random: "随机密钥",
  CPF: "CPF（个人）",
  CNPJ: "CNPJ（企业）",
};
const extra: Record<string, AccountField[]> = {
  CN_BANK_ACCOUNT: [
    { id: "branchName", label: "开户支行", required: true },
    { id: "province", label: "开户省份", required: true },
    { id: "city", label: "开户城市", required: true },
  ],
  US_BANK_ACCOUNT: [
    { id: "addressLine1", label: FIELD_NAMES.addressLine1, required: true },
    { id: "city", label: "收款人城市", required: true },
    { id: "state", label: FIELD_NAMES.state, required: true },
    { id: "postalCode", label: FIELD_NAMES.postalCode, required: true },
  ],
  EUR_IBAN: [{ id: "bic", label: FIELD_NAMES.bic, required: false }],
  GB_IBAN: [{ id: "bic", label: FIELD_NAMES.bic, required: false }],
  BR_BANK_ACCOUNT: [
    { id: "bankName", label: "银行名称", required: true },
    {
      id: "taxId",
      label: FIELD_NAMES.taxId,
      required: true,
      placeholder: "个人 CPF 或企业 CNPJ",
    },
  ],
};
export function accountFields(method: RecipientMethodId): AccountField[] {
  return [
    ...RECIPIENT_METHODS[method].fields.map((f) => ({
      id: f.id,
      label:
        f.id === "accountNumber" && method === "BR_BANK_ACCOUNT"
          ? "银行账号（含校验位）"
          : FIELD_NAMES[f.id],
      required: f.required,
      options: f.options,
      inputMode: f.inputMode === "select" ? ("text" as const) : f.inputMode,
      placeholder:
        f.id === "accountNumber" && method === "BR_BANK_ACCOUNT"
          ? "完整账号，包含校验位"
          : f.id === "pixKey"
            ? "填写对应类型的完整密钥"
            : undefined,
    })),
    ...(extra[method] ?? []),
  ];
}
export function validBrazilTaxId(raw: string): boolean {
  const v = raw.replace(/[.\-/\s]/g, "").toUpperCase();
  if (/^(.)\1+$/.test(v)) return false;
  if (/^\d{11}$/.test(v)) {
    const n = [...v].map(Number);
    for (let len = 9; len <= 10; len++) {
      const sum = n.slice(0, len).reduce((s, x, i) => s + x * (len + 1 - i), 0);
      const digit = ((sum * 10) % 11) % 10;
      if (digit !== n[len]) return false;
    }
    return true;
  }
  if (!/^[A-Z0-9]{12}\d{2}$/.test(v)) return false;
  for (let len = 12; len <= 13; len++) {
    let w = 2,
      sum = 0;
    for (let i = len - 1; i >= 0; i--) {
      sum += (v.charCodeAt(i) - 48) * w;
      w = w === 9 ? 2 : w + 1;
    }
    const remainder = sum % 11;
    if (Number(v[len]) !== (remainder < 2 ? 0 : 11 - remainder)) return false;
  }
  return true;
}
export type FullRecipientInput = {
  country: string;
  currency: string;
  method: RecipientMethodId;
  fields: Record<string, string>;
};
export function validateFullRecipient(input: FullRecipientInput) {
  const errors: Record<string, string> = {},
    fields: Record<string, string> = {};
  if (
    !Object.hasOwn(ACCOUNT_METHODS, input.currency) ||
    !ACCOUNT_METHODS[input.currency]?.includes(input.method)
  )
    return {
      valid: false,
      errors: { method: "该币种不支持此收款方式" },
      fields,
    };
  const country = input.country,
    expected: Record<string, string> = {
      CNY: "CN",
      USD: "US",
      MXN: "MX",
      BRL: "BR",
      GBP: "GB",
    };
  if (
    input.currency === "EUR"
      ? !EURO_AREA_COUNTRIES.includes(
          country as (typeof EURO_AREA_COUNTRIES)[number],
        )
      : expected[input.currency] !== country
  )
    errors.country = "国家与收款币种不匹配";
  const descriptors = accountFields(input.method),
    allowed = new Set(descriptors.map((f) => f.id));
  for (const key of Object.keys(input.fields ?? {}))
    if (!allowed.has(key)) errors.form = "包含当前收款方式不支持的字段";
  for (const f of descriptors) {
    const raw = input.fields?.[f.id];
    if (typeof raw !== "string" && raw !== undefined) {
      errors[f.id] = "请填写有效内容";
      continue;
    }
    let value = (raw ?? "").trim();
    if (f.required && !value) errors[f.id] = "请填写" + f.label;
    if (value.length > 200 || /[\u0000-\u001f\u007f]/.test(value))
      errors[f.id] = f.label + "格式不正确";
    if (
      ["accountNumber", "abaRoutingNumber", "sortCode", "clabe"].includes(f.id)
    )
      value = value.replace(/[\s-]/g, "");
    if (["iban", "bic", "state"].includes(f.id))
      value = value.replace(/\s/g, "").toUpperCase();
    if (
      f.id === "taxId" ||
      (f.id === "pixKey" && ["CPF", "CNPJ"].includes(input.fields?.pixKeyType))
    )
      value = value.replace(/[.\-/\s]/g, "").toUpperCase();
    if (
      f.id === "pixKey" &&
      ["email", "random"].includes(input.fields?.pixKeyType)
    )
      value = value.toLowerCase();
    fields[f.id] = value;
  }
  const base = Object.fromEntries(
    RECIPIENT_METHODS[input.method].fields.map((f) => [f.id, fields[f.id]]),
  );
  const validation = validateRecipientForm(input.method, base);
  for (const e of validation.errors)
    errors[e.field] =
      e.code === "REQUIRED"
        ? "请填写" + (FIELD_NAMES[e.field] ?? "收款信息")
        : (FIELD_NAMES[e.field] ?? "收款信息") + "格式或校验位不正确";
  if (
    (input.method === "EUR_IBAN" || input.method === "GB_IBAN") &&
    fields.iban &&
    !fields.iban.startsWith(country)
  )
    errors.iban = "IBAN 所属国家与所选国家不一致";
  if (fields.bic && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(fields.bic))
    errors.bic = "BIC / SWIFT 应为8位或11位";
  if (input.currency === "USD") {
    if (
      !new Set(
        "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI AA AE AP".split(
          " ",
        ),
      ).has(fields.state ?? "")
    )
      errors.state = "请填写两位州代码";
    if (!/^\d{5}(-\d{4})?$/.test(fields.postalCode ?? ""))
      errors.postalCode = "请填写5位或9位美国邮政编码";
    if (/\bP\.?\s*O\.?\s*BOX\b/i.test(fields.addressLine1 ?? ""))
      errors.addressLine1 = "请填写实际街道地址";
  }
  if (input.method === "BR_BANK_ACCOUNT") {
    if (!/^(?:\d{3}|\d{8})$/.test(fields.bankCode ?? ""))
      errors.bankCode = "请填写3位 COMPE 或8位 ISPB 银行代码";
    if (!/^\d{4}(?:-[0-9X])?$/i.test(fields.branchNumber ?? ""))
      errors.branchNumber = "请填写4位分行号，校验位请用短横线分隔";
  }
  if (fields.abaRoutingNumber && /^0+$/.test(fields.abaRoutingNumber))
    errors.abaRoutingNumber = "ACH 路由号格式不正确";
  if (fields.clabe && /^0+$/.test(fields.clabe))
    errors.clabe = "CLABE 格式不正确";
  if (fields.taxId && !validBrazilTaxId(fields.taxId))
    errors.taxId = "CPF / CNPJ 的长度或校验位不正确";
  if (
    input.method === "BR_PIX" &&
    ["CPF", "CNPJ"].includes(fields.pixKeyType) &&
    !validBrazilTaxId(fields.pixKey)
  )
    errors.pixKey = "CPF / CNPJ 的长度或校验位不正确";
  return { valid: Object.keys(errors).length === 0, errors, fields };
}
