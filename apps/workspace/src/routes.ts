import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  ROUTES,
  MARKETS,
  RECIPIENT_METHODS,
  validateRecipientForm,
  type RecipientMethodId,
} from "../../../packages/core/src/route-catalog";
import { units } from "../../../packages/core/src/money";
import { Auth, HttpError, type Account } from "./auth";

const nullableDecimal = (scale: number) =>
  z
    .string()
    .regex(new RegExp(`^(0|[1-9]\\d{0,14})(\\.\\d{1,${scale}})?$`))
    .nullable();
export const draftInput = z
  .object({
    expectedVersion: z.number().int().min(0).max(2147483646),
    referenceRate: nullableDecimal(8),
    serviceFee: nullableDecimal(6),
    channelFee: nullableDecimal(6),
    minPayout: nullableDecimal(2),
    maxPayout: nullableDecimal(2),
    providerName: z.string().trim().max(100),
    processingNote: z.string().trim().max(500),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.referenceRate !== null && units(v.referenceRate, 8) <= 0n)
      ctx.addIssue({
        code: "custom",
        path: ["referenceRate"],
        message: "Rate must be positive",
      });
    if (
      v.minPayout !== null &&
      v.maxPayout !== null &&
      units(v.minPayout, 2) > units(v.maxPayout, 2)
    )
      ctx.addIssue({
        code: "custom",
        path: ["maxPayout"],
        message: "Maximum must be at least minimum",
      });
    for (const key of ["providerName", "processingNote"] as const)
      if (/[\u0000-\u001f\u007f]/.test(v[key]))
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "Control characters are not allowed",
        });
  });
export async function routeCatalog(auth: Auth, account: Account) {
  const drafts =
    account.role === "merchant_admin"
      ? (
          await auth.pool.query(
            "SELECT route_id,version,document,updated_at FROM workspace.route_drafts",
          )
        ).rows
      : [];
  return {
    executionMode: "manual_record_only",
    realExecutionEnabled: false,
    markets: MARKETS,
    methods: RECIPIENT_METHODS,
    routes: ROUTES.map((route) => {
      const d = drafts.find((row) => row.route_id === route.id);
      return {
        ...route,
        ...(d
          ? { draft: d.document, version: d.version, updatedAt: d.updated_at }
          : { version: 0 }),
      };
    }),
  };
}
export async function saveRouteDraft(
  auth: Auth,
  account: Account,
  id: string,
  input: unknown,
) {
  if (account.role !== "merchant_admin") throw new HttpError(403, "FORBIDDEN");
  if (!ROUTES.some((route) => route.id === id))
    throw new HttpError(404, "ROUTE_NOT_FOUND");
  const { expectedVersion, ...document } = draftInput.parse(input);
  const c = await auth.pool.connect();
  try {
    await c.query("BEGIN");
    // A missing record is insertable only at revision zero; conflicts never silently overwrite.
    const result =
      expectedVersion === 0
        ? await c.query(
            `INSERT INTO workspace.route_drafts(route_id,version,document,updated_by,updated_at)
          VALUES($1,1,$2::jsonb,$3,$4) ON CONFLICT(route_id) DO NOTHING RETURNING version`,
            [id, JSON.stringify(document), account.id, new Date(auth.now())],
          )
        : await c.query(
            `UPDATE workspace.route_drafts SET version=version+1,document=$2::jsonb,updated_by=$3,updated_at=$4
          WHERE route_id=$1 AND version=$5 RETURNING version`,
            [
              id,
              JSON.stringify(document),
              account.id,
              new Date(auth.now()),
              expectedVersion,
            ],
          );
    if (!result.rows[0]) throw new HttpError(409, "DRAFT_VERSION_CONFLICT");
    await c.query(
      "INSERT INTO workspace.auth_audit(id,actor_id,action,subject_hash,created_at) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), account.id, "route.draft.saved", id, new Date(auth.now())],
    );
    await c.query("COMMIT");
    return {
      routeId: id,
      version: result.rows[0].version,
      draft: document,
      status: "draft",
      realExecutionEnabled: false,
    };
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release?.();
  }
}
export function validateRouteRecipient(id: string, input: unknown) {
  const route = ROUTES.find((r) => r.id === id);
  if (!route) throw new HttpError(404, "ROUTE_NOT_FOUND");
  const v = z
    .object({
      method: z.string().max(50),
      fields: z.record(z.string().max(50), z.string().max(200)),
    })
    .strict()
    .parse(input);
  if (!(route.recipientMethods as readonly string[]).includes(v.method))
    throw new HttpError(400, "METHOD_NOT_ALLOWED_FOR_ROUTE");
  return {
    ...validateRecipientForm(v.method as RecipientMethodId, v.fields),
    stored: false,
    payable: false,
  };
}
