import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import {
  PostgresStore,
  SqlClient,
  SqlPool,
} from "../../../packages/core/src/store";
import type { Actor } from "../../../packages/core/src/types";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const credentials = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(12).max(128),
  })
  .strict();
export const registration = credentials
  .extend({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine((v) => !/[\x00-\x1f\x7f]/.test(v)),
    kind: z.enum(["personal", "company"]),
  })
  .strict();
export const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_][a-z0-9_.-]{2,31}$/);
const identifier = z.union([credentials.shape.email, username]);
// Login verifies existing credentials; creation/reset policies are separate.
const loginPassword = z.string().min(1).max(128);
export const loginCredentials = z.union([
  z.object({ identifier, password: loginPassword }).strict(),
  z
    .object({ email: credentials.shape.email, password: loginPassword })
    .strict()
    .transform((v) => ({ identifier: v.email, password: v.password })),
  z
    .object({ username, password: loginPassword })
    .strict()
    .transform((v) => ({ identifier: v.username, password: v.password })),
]);
const adminCredentials = z
  .object({ username, password: credentials.shape.password })
  .strict();
// At most four memory-hard jobs per process; SQL rate limits remain shared across instances.
let hashing = 0;
async function derive(password: string, salt: string): Promise<Buffer> {
  if (hashing >= 4) throw new HttpError(429, "AUTH_BUSY");
  hashing++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        32,
        { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (err, key) => (err ? reject(err) : resolve(key)),
      ),
    );
  } finally {
    hashing--;
  }
}
export async function hashPassword(password: string) {
  credentials.shape.password.parse(password);
  const salt = randomBytes(16).toString("hex");
  return `scrypt-v1$${salt}$${(await derive(password, salt)).toString("hex")}`;
}
async function verify(password: string, encoded?: string) {
  const parts = encoded?.split("$");
  const valid =
    parts?.length === 3 &&
    parts[0] === "scrypt-v1" &&
    /^[a-f0-9]{32}$/.test(parts[1]) &&
    /^[a-f0-9]{64}$/.test(parts[2]);
  const key = await derive(
    password,
    valid ? parts![1] : "00000000000000000000000000000000",
  );
  return (
    timingSafeEqual(
      key,
      valid ? Buffer.from(parts![2], "hex") : Buffer.alloc(32),
    ) && !!valid
  );
}
export interface Account {
  id: string;
  email: string | null;
  username?: string | null;
  display_name: string;
  role: Actor["role"];
  customer_id: string | null;
  payout_provider_id?: string | null;
  customer_kind?: "personal" | "company";
}
export const publicAccount = (a: Account) => ({
  id: a.id,
  email: a.email,
  username: a.username ?? null,
  name: a.display_name,
  role: a.role,
  customerId: a.customer_id,
  ...(a.payout_provider_id ? { payoutProviderId: a.payout_provider_id } : {}),
  kind: a.customer_kind,
});
export const actorFor = (a: Account): Actor => ({
  id: a.id,
  role: a.role,
  ...(a.customer_id ? { customerId: a.customer_id } : {}),
});
export class Auth {
  constructor(
    readonly pool: SqlPool,
    readonly store: PostgresStore,
    readonly now = () => Date.now(),
  ) {}
  async audit(
    client: SqlClient | SqlPool,
    action: string,
    actorId?: string,
    subject?: string,
  ) {
    await client.query(
      "INSERT INTO workspace.auth_audit(id,actor_id,action,subject_hash,created_at) VALUES($1,$2,$3,$4,$5)",
      [
        randomUUID(),
        actorId ?? null,
        action,
        subject ? digest(subject) : null,
        new Date(this.now()),
      ],
    );
  }
  async rate(key: string, limit: number, durationMs: number) {
    const at = new Date(this.now());
    const cutoff = new Date(this.now() - durationMs);
    const r = await this.pool.query(
      `INSERT INTO workspace.rate_limits(key_hash,window_start,count) VALUES($1,$2,1)
      ON CONFLICT(key_hash) DO UPDATE SET
      window_start=CASE WHEN workspace.rate_limits.window_start <= $3 THEN $2 ELSE workspace.rate_limits.window_start END,
      count=CASE WHEN workspace.rate_limits.window_start <= $3 THEN 1 ELSE workspace.rate_limits.count+1 END RETURNING count`,
      [digest(key), at, cutoff],
    );
    if (r.rows[0].count > limit) throw new HttpError(429, "RATE_LIMITED");
  }
  async register(input: unknown) {
    const v = registration.parse(input);
    const passwordHash = await hashPassword(v.password);
    const id = randomUUID(),
      customerId = randomUUID(),
      at = new Date(this.now());
    try {
      return await this.store.transactionWithClient(async (state, c) => {
        await c.query(
          "INSERT INTO workspace.customers(id,kind,created_at) VALUES($1,$2,$3)",
          [customerId, v.kind, at],
        );
        const r = await c.query(
          `INSERT INTO workspace.accounts(id,email,display_name,password_hash,role,customer_id,created_at)
          VALUES($1,$2,$3,$4,'customer',$5,$6) RETURNING id,email,display_name,role,customer_id`,
          [id, v.email, v.name, passwordHash, customerId, at],
        );
        state.customers.push({
          id: customerId,
          name: v.name,
          kind: v.kind,
          status: "pending",
        });
        state.audits.push({
          id: randomUUID(),
          actorId: id,
          action: "customer.registered",
          targetId: customerId,
          data: {},
          at: at.toISOString(),
        });
        await this.audit(c, "account.registered", id);
        return publicAccount({ ...r.rows[0], customer_kind: v.kind });
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new HttpError(409, "EMAIL_IN_USE");
      throw error;
    }
  }
  async login(input: unknown, ip: string) {
    const v = loginCredentials.parse(input);
    await this.rate("login-ip:" + ip, 30, 15 * 60_000);
    await this.rate("login-identifier:" + v.identifier, 10, 15 * 60_000);
    const found = await this.pool.query(
      "SELECT a.*,c.kind AS customer_kind FROM workspace.accounts a LEFT JOIN workspace.customers c ON c.id=a.customer_id WHERE a.email=$1 OR a.username=$1",
      [v.identifier],
    );
    const a = found.rows[0];
    const correct = await verify(v.password, a?.password_hash);
    if (!correct || !a?.enabled) {
      await this.audit(this.pool, "login.failed", undefined, v.identifier);
      throw new HttpError(401, "INVALID_CREDENTIALS");
    }
    const token = randomBytes(32).toString("hex");
    const at = new Date(this.now()),
      expires = new Date(this.now() + 8 * 60 * 60_000);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "INSERT INTO workspace.sessions(token_hash,account_id,created_at,expires_at) VALUES($1,$2,$3,$4)",
        [digest(token), a.id, at, expires],
      );
      await this.audit(c, "login.succeeded", a.id);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release?.();
    }
    return { token, account: publicAccount(a) };
  }
  async current(token: string | undefined): Promise<Account> {
    if (!token) throw new HttpError(401, "UNAUTHENTICATED");
    const r = await this.pool.query(
      `SELECT a.id,a.email,a.username,a.display_name,a.role,a.customer_id,a.payout_provider_id,c.kind AS customer_kind FROM workspace.sessions s
      JOIN workspace.accounts a ON a.id=s.account_id LEFT JOIN workspace.customers c ON c.id=a.customer_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>$2 AND a.enabled`,
      [digest(token), new Date(this.now())],
    );
    if (!r.rows[0]) throw new HttpError(401, "SESSION_EXPIRED");
    return r.rows[0];
  }
  async logout(token: string, a: Account) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "UPDATE workspace.sessions SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL",
        [digest(token), new Date(this.now())],
      );
      await this.audit(c, "logout", a.id);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release?.();
    }
  }
  /** CLI only. Never exposed through HTTP. */
  async createAdmin(input: unknown, name: string) {
    const v = adminCredentials.parse(input);
    const passwordHash = await hashPassword(v.password);
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(
        `INSERT INTO workspace.accounts(id,username,display_name,password_hash,role,created_at)
        VALUES($1,$2,$3,$4,'merchant_admin',$5) RETURNING id`,
        [
          randomUUID(),
          v.username,
          registration.shape.name.parse(name),
          passwordHash,
          new Date(this.now()),
        ],
      );
      await this.audit(c, "admin.cli_created", r.rows[0].id);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release?.();
    }
  }
}
