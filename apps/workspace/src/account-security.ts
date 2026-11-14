import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  Auth,
  HttpError,
  digest,
  hashPassword,
  verifyPassword,
  type Account,
} from "./auth";
import { newTotpSecret, sealSecret, openSecret, totpCounter } from "./totp";
export class AccountSecurity {
  constructor(
    readonly auth: Auth,
    readonly key: Buffer,
  ) {
    if (key.length !== 32) throw Error("Security key required");
  }
  async status(account: Account) {
    const r = (
      await this.auth.pool.query(
        "SELECT * FROM workspace.account_security WHERE account_id=$1",
        [account.id],
      )
    ).rows[0];
    return {
      mfaEnabled: !!r?.totp_secret,
      passwordChanged: !!r?.password_changed_at,
      privileged: ["merchant_admin", "payout_provider"].includes(account.role),
    };
  }
  async password(account: Account, input: unknown, token: string) {
    const v = z
      .object({
        currentPassword: z.string().min(1).max(128),
        password: z.string().min(12).max(128),
      })
      .strict()
      .parse(input);
    if (
      v.password === v.currentPassword ||
      /^(.)\1+$/.test(v.password) ||
      /admin123|password123|123456789/i.test(v.password)
    )
      throw new HttpError(400, "WEAK_PASSWORD");
    const old = (
      await this.auth.pool.query(
        "SELECT password_hash FROM workspace.accounts WHERE id=$1",
        [account.id],
      )
    ).rows[0]?.password_hash;
    if (!(await verifyPassword(v.currentPassword, old)))
      throw new HttpError(403, "INVALID_CREDENTIALS");
    const hash = await hashPassword(v.password),
      c = await this.auth.pool.connect();
    try {
      await c.query("BEGIN");
      const changed = await c.query(
        "UPDATE workspace.accounts SET password_hash=$2 WHERE id=$1 AND password_hash=$3 RETURNING id",
        [account.id, hash, old],
      );
      if (!changed.rows[0]) throw new HttpError(409, "SECURITY_CHANGED");
      await c.query(
        "INSERT INTO workspace.account_security(account_id,password_changed_at) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET password_changed_at=$2,updated_at=$2",
        [account.id, new Date(this.auth.now())],
      );
      await c.query(
        "UPDATE workspace.sessions SET revoked_at=$2 WHERE account_id=$1 AND token_hash<>$3 AND revoked_at IS NULL",
        [account.id, new Date(this.auth.now()), digest(token)],
      );
      await this.auth.audit(c, "password.changed", account.id);
      await c.query("COMMIT");
      return { ok: true };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release?.();
    }
  }
  async setup(account: Account, input: unknown) {
    const v = z
      .object({ password: z.string().min(1).max(128) })
      .strict()
      .parse(input);
    const row = (
      await this.auth.pool.query(
        "SELECT password_hash FROM workspace.accounts WHERE id=$1",
        [account.id],
      )
    ).rows[0];
    if (!(await verifyPassword(v.password, row?.password_hash)))
      throw new HttpError(403, "INVALID_CREDENTIALS");
    const secret = newTotpSecret(),
      sealed = sealSecret(this.key, account.id, secret);
    const r = await this.auth.pool.query(
      "INSERT INTO workspace.account_security(account_id,pending_secret) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET pending_secret=$2,updated_at=now() WHERE workspace.account_security.totp_secret IS NULL RETURNING account_id",
      [account.id, sealed],
    );
    if (!r.rows[0]) throw new HttpError(409, "MFA_ALREADY_ENABLED");
    await this.auth.audit(this.auth.pool, "mfa.enrollment_started", account.id);
    return {
      secret,
      uri: `otpauth://totp/${encodeURIComponent("汇途:" + (account.username ?? account.email ?? account.id))}?secret=${secret}&issuer=${encodeURIComponent("汇途")}&algorithm=SHA1&digits=6&period=30`,
    };
  }
  async confirm(account: Account, input: unknown, token: string) {
    const v = z
      .object({ code: z.string().regex(/^\d{6}$/) })
      .strict()
      .parse(input);
    const c = await this.auth.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT id FROM workspace.accounts WHERE id=$1 FOR UPDATE",
        [account.id],
      );
      const row = (
        await c.query(
          "SELECT * FROM workspace.account_security WHERE account_id=$1 FOR UPDATE",
          [account.id],
        )
      ).rows[0];
      if (!row?.pending_secret || row.totp_secret)
        throw new HttpError(409, "MFA_SETUP_REQUIRED");
      const counter = totpCounter(
        openSecret(this.key, account.id, row.pending_secret),
        v.code,
        this.auth.now(),
      );
      if (counter < 0) throw new HttpError(403, "INVALID_OTP");
      const codes = Array.from({ length: 8 }, () =>
        randomBytes(10).toString("hex"),
      );
      await c.query(
        "UPDATE workspace.account_security SET totp_secret=pending_secret,pending_secret=NULL,last_totp_counter=$2,recovery_hashes=$3::jsonb,updated_at=now() WHERE account_id=$1",
        [
          account.id,
          counter,
          JSON.stringify(codes.map((code) => digest(account.id + ":" + code))),
        ],
      );
      await c.query(
        "UPDATE workspace.sessions SET mfa_verified_at=$2 WHERE token_hash=$1",
        [digest(token), new Date(this.auth.now())],
      );
      await c.query(
        "UPDATE workspace.sessions SET revoked_at=$2 WHERE account_id=$1 AND token_hash<>$3 AND revoked_at IS NULL",
        [account.id, new Date(this.auth.now()), digest(token)],
      );
      await this.auth.audit(c, "mfa.enabled", account.id);
      await c.query("COMMIT");
      return { recoveryCodes: codes };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release?.();
    }
  }
  async stepUp(account: Account, input: unknown, token: string) {
    const v = z
      .object({ code: z.string().min(6).max(40) })
      .strict()
      .parse(input);
    const c = await this.auth.pool.connect();
    try {
      await c.query("BEGIN");
      if (!(await this.auth.consumeMfa(c, account.id, v.code)))
        throw new HttpError(403, "MFA_SETUP_REQUIRED");
      await c.query(
        "UPDATE workspace.sessions SET mfa_verified_at=$2 WHERE token_hash=$1",
        [digest(token), new Date(this.auth.now())],
      );
      await this.auth.audit(c, "mfa.step_up", account.id);
      await c.query("COMMIT");
      return { ok: true };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release?.();
    }
  }
  async requireRecentMfa(account: Account, token: string) {
    if (!(await this.status(account)).mfaEnabled)
      throw new HttpError(403, "MFA_SETUP_REQUIRED");
    const row = (
      await this.auth.pool.query(
        "SELECT mfa_verified_at FROM workspace.sessions WHERE token_hash=$1 AND account_id=$2",
        [digest(token), account.id],
      )
    ).rows[0];
    if (
      !row?.mfa_verified_at ||
      new Date(row.mfa_verified_at).getTime() < this.auth.now() - 10 * 60000
    )
      throw new HttpError(403, "MFA_STEP_UP_REQUIRED");
  }
  async requireReady(account: Account, token: string, recent = false) {
    const s = await this.status(account);
    if (!s.passwordChanged)
      throw new HttpError(403, "PASSWORD_CHANGE_REQUIRED");
    if (s.privileged && !s.mfaEnabled)
      throw new HttpError(403, "MFA_SETUP_REQUIRED");
    if (s.privileged && recent) {
      const row = (
        await this.auth.pool.query(
          "SELECT mfa_verified_at FROM workspace.sessions WHERE token_hash=$1",
          [digest(token)],
        )
      ).rows[0];
      if (
        !row?.mfa_verified_at ||
        new Date(row.mfa_verified_at).getTime() < this.auth.now() - 10 * 60000
      )
        throw new HttpError(403, "MFA_STEP_UP_REQUIRED");
    }
  }
}
