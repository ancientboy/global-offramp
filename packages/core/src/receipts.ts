/** Private receipt originals. Recognition is untrusted and never payment evidence. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { demand, units } from "./money";
import { authorize } from "./security";
import type { Actor, State, Store } from "./types";
export const RECEIPT_MAX_BYTES = 2 * 1024 * 1024;
export const receiptFields = z
  .object({
    amount: z
      .string()
      .regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/)
      .optional(),
    currency: z.enum(["CNY", "CNH", "USD", "HKD", "USDT", "USDC"]).optional(),
    payoutAmount: z
      .string()
      .regex(/^(0|[1-9]\d{0,15})(\.\d{1,8})?$/)
      .optional(),
    payoutCurrency: z
      .enum(["CNY", "CNH", "USD", "HKD", "USDT", "USDC"])
      .optional(),
    recipientName: z.string().trim().min(1).max(120).optional(),
    accountTail: z
      .string()
      .regex(/^\d{4,8}$/)
      .optional(),
    transactionReference: z.string().trim().min(1).max(80).optional(),
    reference: z.string().trim().min(1).max(120).optional(),
    sourceStatus: z.string().max(80).optional(),
    initiatedAt: z.string().max(60).optional(),
    completedAt: z.string().max(60).optional(),
    engine: z.string().max(80).optional(),
    confidence: z.number().min(0).max(100).optional(),
    fieldConfidence: z
      .record(z.string().max(40), z.number().min(0).max(100))
      .refine((v) => Object.keys(v).length <= 20)
      .optional(),
  })
  .strict();
export type ReceiptFields = z.infer<typeof receiptFields>;
export interface PrivateReceipt {
  id: string;
  fileName: string;
  contentType: string;
  size: number;
  sha256: string;
  objectKey: string;
  kind: "single" | "batch";
  uploadedAt: string;
  uploadedBy: string;
  storageMode: "r2_private" | "ephemeral_private";
  quarantine?: {
    reason: "multi_customer_detected" | "batch_scope_changed";
    at: string;
    actorId: string;
  };
  published?: {
    orderId: string;
    purpose: string;
    publishedBy: string;
    publishedAt: string;
  };
  batchPublished?: {
    customerId: string;
    batchId: string;
    scopeDigest: string;
    purpose: string;
    publishedBy: string;
    publishedAt: string;
  };
  recognition?: {
    fields: ReceiptFields;
    rows?: ReceiptFields[];
    status: "unverified";
    updatedAt: string;
  };
  links: {
    orderId: string;
    reason: string;
    confirmedBy: string;
    confirmedAt: string;
    selectedRowIndex?: number;
    recognitionDigest?: string;
    rowDigest?: string;
  }[];
}
export function requireReceiptAdmin(actor: Actor) {
  demand(
    !!actor?.id && actor.role === "merchant_admin",
    "FORBIDDEN",
    "Receipt originals are private to administrators",
  );
}
export function validateReceiptFile(input: unknown) {
  const v = z
    .object({
      fileName: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[^/\\\x00-\x1f]+\.(png|jpg|jpeg|pdf)$/i),
      contentType: z.enum(["image/png", "image/jpeg", "application/pdf"]),
      dataBase64: z
        .string()
        .min(4)
        .max(2796204)
        .regex(
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
        ),
    })
    .strict()
    .parse(input);
  const bytes = Buffer.from(v.dataBase64, "base64");
  demand(
    bytes.length > 0 &&
      bytes.length <= RECEIPT_MAX_BYTES &&
      bytes.toString("base64") === v.dataBase64,
    "INVALID_FILE",
    "Files must be at most 2 MiB",
  );
  const valid =
    v.contentType === "image/png"
      ? bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" &&
        /\.png$/i.test(v.fileName)
      : v.contentType === "image/jpeg"
        ? bytes.subarray(0, 3).toString("hex") === "ffd8ff" &&
          /\.jpe?g$/i.test(v.fileName)
        : bytes.subarray(0, 5).toString() === "%PDF-" &&
          /\.pdf$/i.test(v.fileName);
  demand(
    valid,
    "INVALID_FILE",
    "File signature, extension and type must match",
  );
  return {
    fileName: v.fileName,
    contentType: v.contentType,
    bytes,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
export function recognitionDigest(r: PrivateReceipt) {
  return r.recognition
    ? createHash("sha256")
        .update(
          JSON.stringify({
            fields: r.recognition.fields,
            rows: r.recognition.rows,
          }),
        )
        .digest("hex")
    : undefined;
}
export function receiptScopeDigest(r: PrivateReceipt) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        recognitionDigest: recognitionDigest(r),
        links: r.links,
      }),
    )
    .digest("hex");
}
function rowDigest(row: ReceiptFields) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.fromEntries(
          Object.entries(row).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ),
    )
    .digest("hex");
}
function effectiveLinks(r: PrivateReceipt) {
  return [...new Map(r.links.map((l) => [l.orderId, l])).values()];
}
function validBatchScope(
  s: State,
  r: PrivateReceipt,
  customerId: string,
  batchId: string,
) {
  const batch = s.batches.find(
    (b) => b.id === batchId && b.customerId === customerId,
  );
  return (
    s.customers.some((c) => c.id === customerId && c.kind === "company") &&
    !!batch &&
    s.batchItems.some(
      (item) =>
        batch.itemIds.includes(item.id) &&
        item.batchId === batchId &&
        item.status === "created" &&
        s.orders.some(
          (o) =>
            o.id === item.orderId &&
            o.customerId === customerId &&
            o.batchId === batchId,
        ),
    ) &&
    s.batchItems
      .filter((item) => item.batchId === batchId && item.status === "created")
      .every(
        (item) =>
          batch.itemIds.includes(item.id) &&
          s.orders.some(
            (o) =>
              o.id === item.orderId &&
              o.customerId === customerId &&
              o.batchId === batchId,
          ),
      ) &&
    r.links.every(
      (l) =>
        s.orders.some(
          (o) =>
            o.id === l.orderId &&
            o.customerId === customerId &&
            o.batchId === batchId,
        ) &&
        s.batchItems.some(
          (item) =>
            batch.itemIds.includes(item.id) &&
            item.batchId === batchId &&
            item.orderId === l.orderId &&
            item.status === "created",
        ),
    )
  );
}
function safeReceiptMetadata(r: PrivateReceipt) {
  return {
    id: r.id,
    fileName: `receipt.${r.contentType === "application/pdf" ? "pdf" : r.contentType === "image/png" ? "png" : "jpg"}`,
    contentType: r.contentType,
    size: r.size,
  };
}
export function receiptView(r: PrivateReceipt) {
  const { objectKey, links, ...view } = r;
  return {
    ...view,
    recognitionDigest: recognitionDigest(r),
    scopeDigest: receiptScopeDigest(r),
    orderIds: [...new Set(links.map((l) => l.orderId))],
  };
}
const normalize = (s: string) =>
  s.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();
export function matchReceipt(
  s: State,
  r: PrivateReceipt,
  override?: ReceiptFields,
) {
  const f = override ?? r.recognition?.fields;
  const duplicate = (["reference", "transactionReference"] as const).some(
    (key) =>
      !!f?.[key] &&
      ((s.privateReceipts ?? []).some(
        (x) =>
          x.id !== r.id &&
          [x.recognition?.fields, ...(x.recognition?.rows ?? [])].some(
            (fields) => fields?.[key] === f[key],
          ),
      ) ||
        (r.recognition?.rows ?? []).filter((fields) => fields[key] === f[key])
          .length > 1),
  );
  const candidates: { orderId: string; reasons: string[] }[] = [];
  if (f && !duplicate)
    for (const o of s.orders) {
      if (!["sent", "failed", "unknown"].includes(o.payoutStatus)) continue;
      const b = s.beneficiaries.find((x) => x.id === o.quote.beneficiaryId);
      const amount = f.payoutAmount ?? f.amount;
      const currency = f.payoutAmount ? f.payoutCurrency : f.currency;
      if (
        !amount ||
        !currency ||
        currency !== o.quote.payoutCurrency ||
        units(amount, 8) !== units(o.quote.payoutAmount, 8)
      )
        continue;
      const reference = [f.reference, f.transactionReference].some(
        (ref) =>
          !!ref &&
          [
            o.id,
            o.orderNumber,
            o.clientOrderId,
            o.paymentConfirmation?.providerReference,
            o.paymentConfirmation?.internalRecordId,
            ...s.attempts
              .filter((a) => a.orderId === o.id)
              .map((a) => a.providerReference),
          ].includes(ref),
      );
      const tail =
        !!f.accountTail &&
        !!b &&
        b.accountMasked.replace(/\D/g, "").endsWith(f.accountTail);
      const name =
        !!f.recipientName &&
        !!b &&
        normalize(f.recipientName) === normalize(b.name);
      // Explicit contradictions defeat a reference or name match. No fuzzy matching.
      if ((f.accountTail && !tail) || (f.recipientName && !name)) continue;
      if (reference || tail || name)
        candidates.push({
          orderId: o.id,
          reasons: [
            "exact_amount_currency",
            ...(reference ? ["exact_reference"] : []),
            ...(tail ? ["exact_account_tail"] : []),
            ...(name ? ["exact_recipient_name"] : []),
          ],
        });
    }
  return {
    candidates,
    matchStatus: duplicate
      ? "duplicate_reference"
      : candidates.length === 1
        ? "candidate"
        : candidates.length > 1
          ? "ambiguous"
          : "no_match",
  };
}
export class ReceiptService {
  constructor(
    private store: Store,
    private clock: () => Date,
  ) {}
  async list(actor: Actor) {
    requireReceiptAdmin(actor);
    return (await this.store.read()).privateReceipts?.map(receiptView) ?? [];
  }
  async get(actor: Actor, id: string) {
    requireReceiptAdmin(actor);
    const r = (await this.store.read()).privateReceipts?.find(
      (r) => r.id === id,
    );
    demand(r, "NOT_FOUND", "Receipt not found");
    return r;
  }
  async register(
    actor: Actor,
    v: Omit<PrivateReceipt, "id" | "uploadedAt" | "uploadedBy" | "links">,
  ) {
    requireReceiptAdmin(actor);
    return this.store.transaction((s) => {
      const all = (s.privateReceipts ??= []);
      const existing = all.find((r) => r.sha256 === v.sha256);
      if (existing) return receiptView(existing);
      demand(
        all.length < 500,
        "STORAGE_CAPACITY",
        "Receipt metadata capacity reached",
      );
      const r: PrivateReceipt = {
        ...v,
        id: randomUUID(),
        uploadedAt: this.clock().toISOString(),
        uploadedBy: actor.id,
        links: [],
      };
      all.push(r);
      s.audits.push({
        id: randomUUID(),
        actorId: actor.id,
        action: "receipt.private_uploaded",
        targetId: r.id,
        data: { sha256: r.sha256, size: r.size, kind: r.kind },
        at: r.uploadedAt,
      });
      return receiptView(r);
    });
  }
  async recognize(actor: Actor, id: string, input: unknown) {
    requireReceiptAdmin(actor);
    const { fields, rows, selectedRowIndex } = z
      .object({
        fields: receiptFields,
        rows: z.array(receiptFields).max(100).optional(),
        selectedRowIndex: z.number().int().min(0).max(99).optional(),
      })
      .strict()
      .parse(input);
    return this.store.transaction((s) => {
      const r = s.privateReceipts?.find((r) => r.id === id);
      demand(r, "NOT_FOUND", "Receipt not found");
      demand(
        selectedRowIndex === undefined || !!rows?.[selectedRowIndex],
        "INVALID_INPUT",
        "Selected recognition row does not exist",
      );
      if ((rows?.length ?? 0) > 1) {
        if (r.published && !r.quarantine) {
          r.quarantine = {
            reason: "multi_customer_detected",
            at: this.clock().toISOString(),
            actorId: actor.id,
          };
          s.audits.push({
            id: randomUUID(),
            actorId: actor.id,
            action: "receipt.publication_quarantined",
            targetId: r.id,
            data: { reason: "multi_customer_detected", rowCount: rows!.length },
            at: r.quarantine.at,
          });
        }
        r.kind = "batch";
      }
      const previousDigest = r.recognition
        ? createHash("sha256")
            .update(
              JSON.stringify({
                fields: r.recognition.fields,
                rows: r.recognition.rows,
              }),
            )
            .digest("hex")
        : null;
      const digest = createHash("sha256")
        .update(JSON.stringify({ fields, rows }))
        .digest("hex");
      const revision =
        s.audits.filter(
          (a) =>
            a.action === "receipt.recognition_updated" && a.targetId === r.id,
        ).length + 1;
      r.recognition = {
        fields,
        rows,
        status: "unverified",
        updatedAt: this.clock().toISOString(),
      };
      s.audits.push({
        id: randomUUID(),
        actorId: actor.id,
        action: "receipt.recognition_updated",
        targetId: r.id,
        data: {
          revision,
          previousDigest,
          digest,
          fieldCount: Object.keys(fields).length,
          rowCount: rows?.length ?? 0,
          unverified: true,
        },
        at: r.recognition.updatedAt,
      });
      return {
        receipt: receiptView(r),
        ...matchReceipt(
          s,
          r,
          selectedRowIndex === undefined ? undefined : rows![selectedRowIndex],
        ),
        rowCandidates: (rows ?? []).map((row, rowIndex) => ({
          rowIndex,
          ...matchReceipt(s, r, row),
        })),
      };
    });
  }
  async publish(actor: Actor, id: string, input: unknown) {
    requireReceiptAdmin(actor);
    const v = z
      .object({
        orderId: z.string().min(1).max(100),
        confirmedSingleCustomer: z.literal(true),
        confirmedRedacted: z.literal(true),
        purpose: z.string().trim().min(3).max(300),
      })
      .strict()
      .parse(input);
    return this.store.transaction((s) => {
      const r = s.privateReceipts?.find((x) => x.id === id);
      demand(r, "NOT_FOUND", "Receipt not found");
      demand(
        !r.quarantine &&
          !r.batchPublished &&
          r.kind === "single" &&
          r.links.length === 1 &&
          r.links[0].orderId === v.orderId,
        "INVALID_STATE",
        "Only an explicitly redacted single-order copy can be published",
      );
      if (r.published) return receiptView(r);
      const at = this.clock().toISOString();
      r.published = {
        orderId: v.orderId,
        purpose: v.purpose,
        publishedBy: actor.id,
        publishedAt: at,
      };
      s.audits.push({
        id: randomUUID(),
        actorId: actor.id,
        action: "receipt.redacted_copy_published",
        targetId: v.orderId,
        data: { receiptId: id },
        at,
      });
      return receiptView(r);
    });
  }
  async publishBatch(actor: Actor, id: string, input: unknown) {
    requireReceiptAdmin(actor);
    const v = z
      .object({
        customerId: z.string().min(1).max(100),
        batchId: z.string().min(1).max(100),
        expectedScopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
        confirmedSingleCustomer: z.literal(true),
        confirmedEntireBatch: z.literal(true),
        confirmedNoOtherCustomerData: z.literal(true),
        purpose: z.string().trim().min(3).max(300),
      })
      .strict()
      .parse(input);
    return this.store.transaction((s) => {
      const r = s.privateReceipts?.find((x) => x.id === id);
      demand(r, "NOT_FOUND", "Receipt not found");
      demand(
        !r.quarantine && !r.published,
        "INVALID_STATE",
        "Quarantined or single-order published copies cannot be republished",
      );
      demand(
        v.expectedScopeDigest === receiptScopeDigest(r),
        "STALE_SCOPE",
        "Receipt scope changed; reload and review before publishing",
      );
      demand(
        validBatchScope(s, r, v.customerId, v.batchId),
        "INVALID_SCOPE",
        "Select this company customer's actual submitted batch; all existing associations must belong to that same batch",
      );
      if (r.batchPublished) {
        demand(
          r.batchPublished.customerId === v.customerId &&
            r.batchPublished.batchId === v.batchId,
          "INVALID_SCOPE",
          "Published batch cannot be rebound",
        );
        return receiptView(r);
      }
      r.kind = "batch";
      r.batchPublished = {
        customerId: v.customerId,
        batchId: v.batchId,
        scopeDigest: v.expectedScopeDigest,
        purpose: v.purpose,
        publishedBy: actor.id,
        publishedAt: this.clock().toISOString(),
      };
      s.audits.push({
        id: randomUUID(),
        actorId: actor.id,
        action: "receipt.merchant_batch_published",
        targetId: v.batchId,
        data: {
          receiptId: id,
          customerId: v.customerId,
          scopeDigest: v.expectedScopeDigest,
        },
        at: r.batchPublished.publishedAt,
      });
      return receiptView(r);
    });
  }
  async publishedBatchList(actor: Actor, batchId: string) {
    const s = await this.store.read();
    demand(
      actor.role === "customer" || actor.role === "merchant_admin",
      "FORBIDDEN",
      "Only the customer or administrator can read published receipts",
    );
    const batch = s.batches.find((b) => b.id === batchId);
    demand(batch, "NOT_FOUND", "Batch not found");
    authorize(actor, "order.read", batch.customerId);
    return (s.privateReceipts ?? [])
      .filter(
        (r) =>
          !r.quarantine &&
          r.batchPublished?.batchId === batchId &&
          r.batchPublished.customerId === batch.customerId &&
          validBatchScope(s, r, batch.customerId, batchId),
      )
      .map(safeReceiptMetadata);
  }
  async publishedList(actor: Actor, orderId: string) {
    const s = await this.store.read();
    const o = s.orders.find((x) => x.id === orderId);
    demand(o, "NOT_FOUND", "Order not found");
    demand(
      actor.role === "customer" || actor.role === "merchant_admin",
      "FORBIDDEN",
      "Only the customer or administrator can read published receipts",
    );
    authorize(actor, "order.read", o.customerId);
    return (s.privateReceipts ?? [])
      .filter(
        (r) =>
          !r.quarantine &&
          !r.batchPublished &&
          r.kind === "single" &&
          r.published?.orderId === orderId,
      )
      .map((r) => ({
        id: r.id,
        fileName: `receipt.${r.contentType === "application/pdf" ? "pdf" : r.contentType === "image/png" ? "png" : "jpg"}`,
        contentType: r.contentType,
        size: r.size,
      }));
  }
  async publishedGet(actor: Actor, id: string) {
    const s = await this.store.read();
    demand(
      actor.role === "customer" || actor.role === "merchant_admin",
      "FORBIDDEN",
      "Only the customer or administrator can read published receipts",
    );
    const r = s.privateReceipts?.find((x) => x.id === id);
    demand(
      r && !r.quarantine && (r.published || r.batchPublished),
      "NOT_FOUND",
      "Published receipt not found or access revoked",
    );
    if (r.batchPublished) {
      const grant = r.batchPublished;
      authorize(actor, "order.read", grant.customerId);
      demand(
        validBatchScope(s, r, grant.customerId, grant.batchId),
        "NOT_FOUND",
        "Published receipt access revoked",
      );
    } else {
      const o = s.orders.find((x) => x.id === r.published!.orderId);
      demand(
        o &&
          r.kind === "single" &&
          r.links.length === 1 &&
          r.links[0].orderId === o.id,
        "NOT_FOUND",
        "Published receipt access revoked",
      );
      authorize(actor, "order.read", o.customerId);
    }
    return r;
  }
  async link(actor: Actor, id: string, input: unknown) {
    requireReceiptAdmin(actor);
    const v = z
      .object({
        orderId: z.string().min(1).max(100),
        reason: z.string().trim().min(3).max(500),
        confirmed: z.literal(true),
        selectedRowIndex: z.number().int().min(0).max(99).optional(),
        expectedRecognitionDigest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .strict()
      .parse(input);
    return this.store.transaction((s) => {
      const r = s.privateReceipts?.find((r) => r.id === id);
      demand(r, "NOT_FOUND", "Receipt not found");
      demand(
        (v.selectedRowIndex === undefined &&
          v.expectedRecognitionDigest === undefined) ||
          (!!v.expectedRecognitionDigest &&
            v.expectedRecognitionDigest === recognitionDigest(r)),
        "STALE_RECOGNITION",
        "Recognition changed; reload and review the selected row before linking",
      );
      demand(
        v.selectedRowIndex === undefined ||
          !!r.recognition?.rows?.[v.selectedRowIndex],
        "INVALID_INPUT",
        "Selected recognition row does not exist",
      );
      const o = s.orders.find((o) => o.id === v.orderId);
      demand(o, "NOT_FOUND", "Order not found");
      demand(
        ["sent", "failed", "unknown"].includes(o.payoutStatus),
        "INVALID_STATE",
        "Only sent, failed or unknown orders can receive receipt associations",
      );
      demand(
        v.selectedRowIndex === undefined ||
          !effectiveLinks(r).some(
            (l) =>
              l.selectedRowIndex === v.selectedRowIndex && l.orderId !== o.id,
          ),
        "ROW_ALREADY_LINKED",
        "This reviewed receipt row is already linked to another order",
      );
      const existingLink = effectiveLinks(r).find((l) => l.orderId === o.id);
      const currentRowDigest =
        v.selectedRowIndex === undefined
          ? undefined
          : rowDigest(r.recognition!.rows![v.selectedRowIndex]);
      if (
        existingLink &&
        (v.selectedRowIndex === undefined ||
          (existingLink.selectedRowIndex === v.selectedRowIndex &&
            existingLink.rowDigest === currentRowDigest))
      )
        return receiptView(r);
      demand(
        !r.published && !r.batchPublished,
        "INVALID_STATE",
        "Published single-customer copies cannot link to additional orders",
      );
      const at = this.clock().toISOString();
      r.links.push({
        orderId: o.id,
        reason: v.reason,
        confirmedBy: actor.id,
        confirmedAt: at,
        selectedRowIndex: v.selectedRowIndex,
        rowDigest: currentRowDigest,
        recognitionDigest: r.recognition
          ? createHash("sha256")
              .update(
                JSON.stringify({
                  fields: r.recognition.fields,
                  rows: r.recognition.rows,
                }),
              )
              .digest("hex")
          : undefined,
      });
      o.receiptAttachmentIds ??= [];
      if (!o.receiptAttachmentIds.includes(r.id))
        o.receiptAttachmentIds.push(r.id);
      o.receiptStatus = "uploaded";
      s.audits.push({
        id: randomUUID(),
        actorId: actor.id,
        action: "receipt.manually_linked",
        targetId: o.id,
        data: {
          receiptId: r.id,
          reason: v.reason,
          recognitionUnverified: true,
          selectedRowIndex: v.selectedRowIndex ?? null,
        },
        at,
      });
      return receiptView(r);
    });
  }
}
