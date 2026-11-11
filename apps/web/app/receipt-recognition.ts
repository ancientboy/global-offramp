/** Local OCR suggestions only. Never a bank verification or payment transition. */
export interface ReceiptFields {
  amount?: string;
  currency?: string;
  payoutAmount?: string;
  payoutCurrency?: string;
  transactionReference?: string;
  recipientName?: string;
  accountTail?: string;
  reference?: string;
  sourceStatus?: string;
  initiatedAt?: string;
  completedAt?: string;
  engine?: string;
  confidence?: number;
  fieldConfidence?: Record<string, number>;
}
export function parseReceiptText(
  text: string,
  confidence: number,
): ReceiptFields {
  const normalized = text.normalize("NFKC").replace(/[ \t]+/g, " ");
  const compact = normalized.replace(
    /(?<=[\u3400-\u9fff]) +(?=[\u3400-\u9fff])/g,
    "",
  );
  const fields: ReceiptFields = {
    engine: "tesseract.js-local-chi_sim+eng",
    confidence: Math.max(0, Math.min(100, Math.round(confidence))),
    fieldConfidence: {},
  };
  const put = (key: keyof ReceiptFields, value: string | undefined) => {
    if (value) {
      (fields as Record<string, unknown>)[key] = value;
      fields.fieldConfidence![key] = fields.confidence!;
    }
  };
  const match = (re: RegExp) => compact.match(re)?.[1]?.trim();
  put("sourceStatus", match(/状态\s*[:：]?\s*(成功|失败|处理中|待处理)/));
  put(
    "reference",
    match(/结汇单号\s*[:：]?\s*([A-Z0-9][A-Z0-9-]{5,63})(?=\s|$)/i),
  );
  put(
    "transactionReference",
    match(/交易订单号\s*[:：]?\s*([A-Z0-9][A-Z0-9-]{5,79})(?=\s|$)/i),
  );
  put(
    "recipientName",
    match(
      /收款方名称\s*[:：]?\s*([\u3400-\u9fff]{2,16}|[A-Za-z][A-Za-z .'-]{1,60})(?=\n|$)/,
    ),
  );
  const account = match(/收款账[户号]\s*[:：]?\s*([\d*×Xx• ]{4,40})/);
  put("accountTail", account?.replace(/ /g, "").match(/(\d{4})$/)?.[1]);
  for (const [label, amountKey, currencyKey] of [
    ["结汇金额", "amount", "currency"],
    ["预计到账金额", "payoutAmount", "payoutCurrency"],
  ] as const) {
    const m = compact.match(
      new RegExp(
        `${label}\\s*[:：]?\\s*(\\d{1,12}(?:,\\d{3})*(?:\\.\\d{1,2})?)\\s*(CNH|CNY|USD|HKD|USDT|USDC)\\b`,
        "i",
      ),
    );
    put(amountKey, m?.[1].replace(/,/g, ""));
    put(currencyKey, m?.[2].toUpperCase());
  }
  for (const [label, key] of [
    ["发起时间", "initiatedAt"],
    ["完成时间", "completedAt"],
  ] as const) {
    const value = match(
      new RegExp(
        `${label}\\s*[:：]?\\s*(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2})`,
      ),
    );
    if (value && Number.isFinite(Date.parse(value.replace(" ", "T") + "Z")))
      put(key, value);
  }
  // Multiple beneficiary / amount groups are a batch document, not one matching identity.
  if (
    ["收款方名称", "收款账户", "结汇金额", "预计到账金额"].some(
      (label) => compact.split(label).length > 2,
    )
  ) {
    delete fields.recipientName;
    delete fields.accountTail;
    delete fields.amount;
    delete fields.currency;
    delete fields.payoutAmount;
    delete fields.payoutCurrency;
    fields.fieldConfidence = {};
  }
  return fields;
}
export function reliableRecognition(fields: ReceiptFields) {
  return (
    (fields.confidence ?? 0) >= 75 &&
    !!fields.payoutAmount &&
    !!fields.payoutCurrency &&
    !!fields.accountTail &&
    !!fields.recipientName
  );
}
export function validateReceiptFile(file: {
  size: number;
  type: string;
}): string | null {
  if (!["image/png", "image/jpeg", "application/pdf"].includes(file.type))
    return "仅支持 PNG、JPEG 或 PDF";
  if (file.size <= 0 || file.size > 2 * 1024 * 1024)
    return "单个文件须为 1 字节至 2 MiB";
  return null;
}

/** Conservative table parser: one amount-led row group; never joins identities across rows. */
export function parseReceiptRows(
  text: string,
  confidence: number,
): ReceiptFields[] {
  const normalized = text
    .normalize("NFKC")
    .replace(/(?<=[\u3400-\u9fff]) +(?=[\u3400-\u9fff])/g, "");
  if (
    !/预计到账金额/.test(normalized) ||
    !/创建时间/.test(normalized) ||
    !/完成时间/.test(normalized)
  )
    return [];
  const amounts = [
    ...normalized.matchAll(
      /\b(\d{1,12}(?:,\d{3})*\.\d{2})\s*(CNY|CNH|USD|HKD)\b/g,
    ),
  ];
  if (amounts.length < 2) return [];
  return amounts.slice(0, 100).map((m, i) => {
    const row = normalized.slice(
      m.index,
      amounts[i + 1]?.index ?? normalized.length,
    );
    const fields: ReceiptFields = {
      engine: "tesseract.js-local-table",
      confidence: Math.max(0, Math.min(100, Math.round(confidence))),
      payoutAmount: m[1].replace(/,/g, ""),
      payoutCurrency: m[2],
    };
    const name = row.match(
      /第三方账户\s*[|丨I｜:：]\s*([\u3400-\u9fff]{2,12})\s*[|丨I｜]/,
    )?.[1];
    const tail = row.match(/\d{3,8}\s*[*×Xx•]{2,}\s*(\d{4})(?!\d)/)?.[1];
    const ambiguousIdentity =
      (row.match(/第三方账户/g) ?? []).length > 1 ||
      [...row.matchAll(/\d{3,8}\s*[*×Xx•]{2,}\s*(\d{4})(?!\d)/g)].length > 1;
    if (name && !ambiguousIdentity) fields.recipientName = name;
    if (tail && !ambiguousIdentity) fields.accountTail = tail;
    const status = row.match(/成功|失败|处理中/)?.[0];
    if (status) fields.sourceStatus = status;
    const times = [
      ...row.matchAll(
        /(\d{4})\s*-\s*(\d{2})\s*-\s*(\d{2})\s+(\d{2}:\d{2}:\d{2})/g,
      ),
    ].map((v) => `${v[1]}-${v[2]}-${v[3]} ${v[4]}`);
    if (times.length === 2 && !ambiguousIdentity) {
      fields.initiatedAt = times[0];
      fields.completedAt = times[1];
    }
    return fields;
  });
}
