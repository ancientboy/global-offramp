import { randomBytes, randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  Auth,
  HttpError,
  actorFor,
  hashPassword,
  username,
  type Account,
  registration,
} from "./auth";
import { OfframpService } from "../../../packages/core/src/service";
export const invitationCode = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
function administrator(account: Account) {
  if (account.role !== "merchant_admin") throw new HttpError(403, "FORBIDDEN");
}
function invitation(origin: string, code: string) {
  return origin + "/workspace?invite=" + encodeURIComponent(code);
}
export async function publicInvitation(auth: Auth, code: string) {
  if (!invitationCode.safeParse(code).success)
    throw new HttpError(404, "INVITE_UNAVAILABLE");
  const r = await auth.pool.query(
    "SELECT p.name FROM workspace.partners p JOIN workspace.accounts a ON a.partner_id=p.id AND a.role='partner' AND a.enabled WHERE p.invite_code=$1 AND p.status='active'",
    [code],
  );
  if (!r.rows[0]) throw new HttpError(404, "INVITE_UNAVAILABLE");
  return { partnerName: r.rows[0].name };
}
export async function listPartners(
  auth: Auth,
  account: Account,
  origin: string,
) {
  administrator(account);
  const result = await auth.pool.query(
    "SELECT p.id,p.name,p.status,p.invite_code,p.created_at,a.username,(SELECT count(*)::int FROM workspace.customer_attributions t WHERE t.partner_id=p.id) AS customer_count FROM workspace.partners p JOIN workspace.accounts a ON a.partner_id=p.id AND a.role='partner' ORDER BY p.created_at DESC,p.id",
  );
  return result.rows.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    username: p.username,
    createdAt: new Date(p.created_at).toISOString(),
    customerCount: p.customer_count,
    inviteUrl: invitation(origin, p.invite_code),
  }));
}
export async function createPartner(
  auth: Auth,
  account: Account,
  origin: string,
  input: unknown,
) {
  administrator(account);
  const v = z
    .object({
      username,
      name: registration.shape.name,
      password: z.string().min(12).max(128),
    })
    .strict()
    .parse(input);
  const hash = await hashPassword(v.password),
    id = randomUUID(),
    code = randomBytes(24).toString("base64url"),
    at = new Date(auth.now());
  const c = await auth.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(
      "INSERT INTO workspace.partners(id,name,invite_code,status,created_at,updated_at) VALUES($1,$2,$3,'active',$4,$4)",
      [id, v.name, code, at],
    );
    await c.query(
      "INSERT INTO workspace.accounts(id,username,display_name,password_hash,role,partner_id,created_at) VALUES($1,$2,$3,$4,'partner',$5,$6)",
      [randomUUID(), v.username, v.name, hash, id, at],
    );
    await auth.audit(c, "partner.created", account.id, id);
    await c.query("COMMIT");
    return {
      id,
      name: v.name,
      username: v.username,
      status: "active",
      customerCount: 0,
      createdAt: at.toISOString(),
      inviteUrl: invitation(origin, code),
    };
  } catch (error) {
    await c.query("ROLLBACK");
    if ((error as any).code === "23505")
      throw new HttpError(409, "USERNAME_IN_USE");
    throw error;
  } finally {
    c.release?.();
  }
}
export async function setPartnerStatus(
  auth: Auth,
  account: Account,
  id: string,
  input: unknown,
) {
  administrator(account);
  const v = z
    .object({ status: z.enum(["active", "disabled"]) })
    .strict()
    .parse(input);
  const c = await auth.pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(
      "SELECT id FROM workspace.partners WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (!r.rows[0]) throw new HttpError(404, "NOT_FOUND");
    await c.query(
      "UPDATE workspace.partners SET status=$2,updated_at=$3 WHERE id=$1",
      [id, v.status, new Date(auth.now())],
    );
    if (v.status === "disabled")
      await c.query(
        "UPDATE workspace.sessions SET revoked_at=$2 WHERE account_id IN(SELECT id FROM workspace.accounts WHERE partner_id=$1) AND revoked_at IS NULL",
        [id, new Date(auth.now())],
      );
    await auth.audit(c, "partner.status_changed", account.id, id);
    await c.query("COMMIT");
    return { id, status: v.status };
  } catch (error) {
    await c.query("ROLLBACK");
    throw error;
  } finally {
    c.release?.();
  }
}
export async function partnerDashboard(
  auth: Auth,
  account: Account,
  origin: string,
) {
  if (account.role !== "partner" || !account.partner_id)
    throw new HttpError(403, "FORBIDDEN");
  const p = (
    await auth.pool.query(
      "SELECT id,name,invite_code FROM workspace.partners WHERE id=$1 AND status='active'",
      [account.partner_id],
    )
  ).rows[0];
  if (!p) throw new HttpError(403, "PARTNER_UNAVAILABLE");
  const attributed = (
    await auth.pool.query(
      "SELECT customer_id,created_at FROM workspace.customer_attributions WHERE partner_id=$1 ORDER BY created_at DESC,customer_id",
      [p.id],
    )
  ).rows;
  const core = new OfframpService(auth.store, () => new Date(auth.now())),
    state = await auth.store.read(),
    dashboard = await core.dashboard(actorFor(account));
  const funded = new Set(
    (
      await auth.pool.query(
        "SELECT DISTINCT f.customer_id FROM workspace.funding_payments f JOIN workspace.customer_attributions a ON a.customer_id=f.customer_id WHERE a.partner_id=$1 AND f.credited_amount>0",
        [p.id],
      )
    ).rows.map((r) => r.customer_id),
  );
  for (const a of state.audits)
    if (
      a.action === "wallet.deposited" &&
      typeof a.data.customerId === "string"
    )
      funded.add(a.data.customerId);
  const completed = new Set(
    state.orders
      .filter(
        (o) => o.payoutStatus === "sent" && (!!o.completion || o.reconciled),
      )
      .map((o) => o.customerId),
  );
  return {
    funnel: {
      registered: attributed.length,
      funded: attributed.filter((r) => funded.has(r.customer_id)).length,
      completed: attributed.filter((r) => completed.has(r.customer_id)).length,
    },
    partner: {
      id: p.id,
      name: p.name,
      inviteUrl: invitation(origin, p.invite_code),
    },
    customers: attributed.map((row) => {
      const c = state.customers.find(
        (c) => c.id === row.customer_id && c.partnerId === p.id,
      );
      if (!c) throw new HttpError(503, "ATTRIBUTION_UNAVAILABLE");
      return {
        alias:
          "客户-" + createHash("sha256").update(c.id).digest("hex").slice(0, 6),
        displayName: Array.from(c.name)[0] + "**",
        kind: c.kind,
        status: c.status,
        registeredAt: new Date(row.created_at).toISOString(),
      };
    }),
    commissions: dashboard.commissions ?? [],
    settlements: dashboard.settlements ?? [],
  };
}
