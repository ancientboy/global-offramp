import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Auth, HttpError, type Account } from "./auth";
import { transfer } from "../../../packages/core/src/ledger";
import { units } from "../../../packages/core/src/money";
import {
  NowPayments,
  DEPOSIT_NETWORKS,
  decimal6,
  paymentId,
  verifyIpn,
} from "./nowpayments";
export type FundsMode = "sandbox" | "live";
export async function bindFundsMode(
  auth: Auth,
  mode: FundsMode,
  simulated: boolean,
) {
  if (mode === "live" && simulated)
    throw Error("Live funds cannot enable simulated deposits");
  await auth.store.transactionWithClient(async (s, c) => {
    const row = (
      await c.query("SELECT mode FROM workspace.funds_environment WHERE id=1")
    ).rows[0];
    if (row && row.mode !== mode)
      throw Error("Funds environment is immutable; use a separate database");
    if (
      mode === "live" &&
      (s.journals.some((j) =>
        j.lines.some((l) => l.account.includes(":mock")),
      ) ||
        (!row && s.orders.length > 0))
    )
      throw Error("Test data cannot enter live funds database");
    await c.query(
      "INSERT INTO workspace.funds_environment(id,mode) VALUES(1,$1) ON CONFLICT(id) DO NOTHING",
      [mode],
    );
  });
}
export class Funding {
  readonly networks;
  private busy = false;
  constructor(
    readonly auth: Auth,
    readonly provider: NowPayments,
    readonly origin: string,
    readonly mode: FundsMode,
    readonly enabledNetworks: string[],
    readonly enabled = false,
    readonly maxDeposit = "1000",
    readonly dailyLimit = "5000",
  ) {
    this.networks = DEPOSIT_NETWORKS.filter((n) =>
      enabledNetworks.includes(n.id),
    );
    if (enabledNetworks.some((n) => !DEPOSIT_NETWORKS.some((x) => x.id === n)))
      throw Error("Unknown deposit network");
    if (
      enabled &&
      (mode !== "live" || provider.sandbox || !this.networks.length)
    )
      throw Error(
        "Real deposits require isolated live mode and reviewed networks",
      );
  }
  publicConfig() {
    return {
      enabled: this.enabled,
      networks: this.enabled ? this.networks : [],
      creditPolicy: "settled_net",
      maxDeposit: this.maxDeposit,
    };
  }
  async list(account: Account) {
    if (!["customer", "merchant_admin"].includes(account.role))
      throw new HttpError(403, "FORBIDDEN");
    const r = await this.auth.pool.query(
      "SELECT id,currency,pay_currency,requested_amount::text,pay_address,pay_amount,extra_id,status,credited_amount::text,created_at,updated_at FROM workspace.funding_payments WHERE ($1::text IS NULL OR customer_id=$1) ORDER BY created_at DESC LIMIT 100",
      [account.role === "customer" ? account.customer_id : null],
    );
    return r.rows;
  }
  async create(account: Account, input: unknown) {
    if (!this.enabled) throw new HttpError(503, "DEPOSITS_UNAVAILABLE");
    if (account.role !== "customer" || !account.customer_id)
      throw new HttpError(403, "FORBIDDEN");
    const v = z
      .object({
        currency: z.enum(["USDT", "USDC"]),
        network: z.string(),
        amount: z.string().regex(/^\d{1,7}(\.\d{1,6})?$/),
        idempotencyKey: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/),
      })
      .strict()
      .parse(input);
    const n = this.networks.find(
      (n) => n.id === v.network && n.asset === v.currency,
    );
    if (!n) throw new HttpError(400, "UNSUPPORTED_NETWORK");
    const amount = decimal6(v.amount),
      count = units(amount, 6);
    if (count <= 0n || count > units(this.maxDeposit, 6))
      throw new HttpError(400, "DEPOSIT_LIMIT_EXCEEDED");
    const existing = (
      await this.auth.pool.query(
        "SELECT * FROM workspace.funding_payments WHERE account_id=$1 AND idempotency_key=$2",
        [account.id, v.idempotencyKey],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.pay_currency !== v.network ||
        units(String(existing.requested_amount), 6) !== count
      )
        throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return this.view(existing);
    }
    const minimum = await this.provider.minimum(n.id);
    if (count < units(minimum, 6))
      throw new HttpError(400, "BELOW_DEPOSIT_MINIMUM");
    const id = "HTDEP-" + randomUUID();
    await this.auth.store
      .transactionWithClient(async (s, c) => {
        if (
          !s.customers.some(
            (x) => x.id === account.customer_id && x.status === "approved",
          )
        )
          throw new HttpError(403, "CUSTOMER_NOT_APPROVED");
        // Global state lock serializes reservations and makes the rolling limit atomic.
        const totals = (
          await c.query(
            "SELECT COALESCE(sum(requested_amount),0)::text AS total FROM workspace.funding_payments WHERE account_id=$1 AND created_at>$2",
            [account.id, new Date(this.auth.now() - 86400000)],
          )
        ).rows[0];
        if (units(totals.total, 6) + count > units(this.dailyLimit, 6))
          throw new HttpError(429, "DAILY_DEPOSIT_LIMIT");
        await c.query(
          "INSERT INTO workspace.funding_payments(id,account_id,customer_id,idempotency_key,currency,pay_currency,requested_amount) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            id,
            account.id,
            account.customer_id,
            v.idempotencyKey,
            v.currency,
            n.id,
            amount,
          ],
        );
        await this.auth.audit(c, "deposit.created", account.id, id);
      })
      .catch(async (e) => {
        if (e.code === "23505")
          throw new HttpError(409, "DEPOSIT_ALREADY_CREATED");
        throw e;
      });
    try {
      const response = await this.provider.create(
        id,
        amount,
        n.id,
        this.origin + "/workspace/api/payments/nowpayments/ipn",
      );
      const pid = paymentId(response.payment_id);
      if (
        response.order_id !== id ||
        response.pay_currency !== n.id ||
        typeof response.pay_address !== "string" ||
        !response.pay_address ||
        response.pay_address.length > 300
      )
        throw new HttpError(502, "INVALID_PROVIDER_RESPONSE");
      const payAmount = decimal6(response.pay_amount);
      if (units(payAmount, 6) <= 0n)
        throw new HttpError(502, "INVALID_PROVIDER_AMOUNT");
      const r = await this.auth.pool.query(
        "UPDATE workspace.funding_payments SET provider_id=$2,pay_address=$3,pay_amount=$4,extra_id=$5,status='waiting',updated_at=now() WHERE id=$1 RETURNING *",
        [
          id,
          pid,
          response.pay_address,
          String(response.pay_amount),
          response.payin_extra_id == null
            ? null
            : String(response.payin_extra_id),
        ],
      );
      return this.view(r.rows[0]);
    } catch (e) {
      // Never repeat an ambiguous create request: a timeout may already have created an address.
      await this.auth.pool.query(
        "UPDATE workspace.funding_payments SET status='creation_unknown',review_reason='CREATE_REQUIRES_RECONCILIATION',updated_at=now() WHERE id=$1",
        [id],
      );
      await this.alert("deposit.creation_unknown", id);
      throw e;
    }
  }
  view(r: any) {
    return {
      id: r.id,
      currency: r.currency,
      pay_currency: r.pay_currency,
      requested_amount: String(r.requested_amount),
      pay_address: r.pay_address,
      pay_amount: r.pay_amount,
      extra_id: r.extra_id,
      status: r.status,
      credited_amount: r.credited_amount ? String(r.credited_amount) : null,
      created_at: r.created_at,
    };
  }
  async ipn(raw: string, signature: string | null) {
    const { value, digest } = verifyIpn(
        raw,
        signature,
        this.provider.ipnSecret,
      ),
      pid = paymentId(value.payment_id);
    const c = await this.auth.pool.connect();
    try {
      await c.query("BEGIN");
      const r = await c.query(
        "INSERT INTO workspace.funding_inbox(digest,payment_id) VALUES($1,$2) ON CONFLICT(digest) DO NOTHING RETURNING digest",
        [digest, pid],
      );
      if (r.rows[0])
        await c.query(
          "UPDATE workspace.funding_payments SET next_check_at=now() WHERE provider_id=$1",
          [pid],
        );
      await c.query("COMMIT");
      return { accepted: true };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release?.();
    }
  }
  async alert(kind: string, id: string) {
    await this.auth.pool.query(
      "INSERT INTO workspace.operational_alerts(id,kind,resource_id) VALUES($1,$2,$3) ON CONFLICT(kind,resource_id) DO NOTHING",
      [randomUUID(), kind, id],
    );
  }
  async refresh(row: any) {
    const observedAt = (
      await this.auth.pool.query("SELECT clock_timestamp()::text AS at")
    ).rows[0].at;
    const p = await this.provider.get(row.provider_id),
      pid = paymentId(p.payment_id);
    // Callback is a wake-up signal only. Financial decisions use the authenticated provider GET.
    await this.auth.store.transactionWithClient(async (s, c) => {
      const r = (
        await c.query(
          "SELECT *,last_observation_at>$2::timestamptz AS superseded FROM workspace.funding_payments WHERE id=$1 FOR UPDATE",
          [row.id, observedAt],
        )
      ).rows[0];
      if (r.superseded) return;
      let review: string | null = null,
        amount: string | null = null;
      if (
        pid !== r.provider_id ||
        p.order_id !== r.id ||
        p.pay_currency !== r.pay_currency ||
        p.pay_address !== r.pay_address
      )
        review = "PAYMENT_IDENTITY_MISMATCH";
      else if (p.payment_status === "finished") {
        if (p.outcome_currency !== r.pay_currency)
          review = "SETTLEMENT_ASSET_MISMATCH";
        else {
          try {
            amount = decimal6(p.outcome_amount);
            if (
              units(amount, 6) <= 0n ||
              units(amount, 6) > units(this.maxDeposit, 6)
            )
              review = "SETTLEMENT_AMOUNT_REVIEW";
          } catch {
            review = "SETTLEMENT_AMOUNT_REVIEW";
          }
        }
      } else if (
        ["partially_paid", "wrong_asset_confirmed", "refunded"].includes(
          p.payment_status,
        )
      )
        review = "PAYMENT_REQUIRES_REVIEW";
      else if (
        ![
          "waiting",
          "confirming",
          "confirmed",
          "sending",
          "failed",
          "expired",
        ].includes(p.payment_status)
      )
        review = "UNKNOWN_PROVIDER_STATUS";
      if (
        r.journal_id &&
        (p.payment_status !== "finished" ||
          !amount ||
          units(amount, 6) !== units(String(r.credited_amount), 6))
      )
        review = "CREDITED_PAYMENT_CHANGED";
      if (!review && amount && !r.journal_id) {
        const j = transfer(
          s,
          "nowpayments:" + r.provider_id,
          r.currency,
          amount,
          "asset:treasury:nowpayments",
          `liability:wallet:${r.customer_id}`,
          new Date(this.auth.now()),
        );
        // Must use exactly the core wallet account namespace (verified by integration tests).
        await c.query(
          "UPDATE workspace.funding_payments SET credited_amount=$2,journal_id=$3 WHERE id=$1",
          [r.id, amount, j.id],
        );
        s.audits.push({
          id: randomUUID(),
          actorId: "nowpayments",
          action: "wallet.deposit_settled",
          targetId: r.customer_id,
          data: { paymentId: r.id, currency: r.currency, amount },
          at: new Date(this.auth.now()).toISOString(),
        });
      }
      const status = review
        ? "review"
        : r.journal_id
          ? "credited"
          : amount
            ? "credited"
            : p.payment_status;
      await c.query(
        "UPDATE workspace.funding_payments SET status=$2,review_reason=$3,checked_at=now(),last_observation_at=$4,next_check_at=now()+interval '15 minutes',updated_at=now() WHERE id=$1",
        [r.id, status, review, observedAt],
      );
      if (review === "CREDITED_PAYMENT_CHANGED") {
        const customer = s.customers.find((x) => x.id === r.customer_id);
        if (customer) customer.status = "suspended";
        s.audits.push({
          id: randomUUID(),
          actorId: "nowpayments",
          action: "customer.funding_blocked",
          targetId: r.customer_id,
          data: { paymentId: r.id, reason: review },
          at: new Date(this.auth.now()).toISOString(),
        });
      }
      if (review)
        await c.query(
          "INSERT INTO workspace.operational_alerts(id,kind,resource_id) VALUES($1,$2,$3) ON CONFLICT(kind,resource_id) DO NOTHING",
          [randomUUID(), review, r.id],
        );
    });
  }
  async tick() {
    if (this.busy || !this.enabled) return;
    this.busy = true;
    try {
      const rows = (
        await this.auth.pool.query(
          "SELECT * FROM workspace.funding_payments WHERE provider_id IS NOT NULL AND next_check_at<=now() ORDER BY next_check_at LIMIT 20",
        )
      ).rows;
      for (const row of rows) {
        try {
          await this.refresh(row);
        } catch {
          await this.alert("deposit.provider_check_failed", row.id);
          await this.auth.pool.query(
            "UPDATE workspace.funding_payments SET next_check_at=now()+interval '5 minutes' WHERE id=$1",
            [row.id],
          );
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async recheck(account: Account, id: string) {
    if (!this.enabled) throw new HttpError(503, "DEPOSITS_UNAVAILABLE");
    if (account.role !== "merchant_admin")
      throw new HttpError(403, "FORBIDDEN");
    const row = (
      await this.auth.pool.query(
        "SELECT * FROM workspace.funding_payments WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!row?.provider_id) throw new HttpError(409, "PAYMENT_NOT_LINKED");
    await this.refresh(row);
    await this.auth.audit(this.auth.pool, "deposit.rechecked", account.id, id);
    return { ok: true };
  }
  async summary(account: Account) {
    if (account.role !== "merchant_admin")
      throw new HttpError(403, "FORBIDDEN");
    const payments = (
      await this.auth.pool.query(
        "SELECT currency,status,count(*)::int AS count,COALESCE(sum(credited_amount),0)::text AS credited FROM workspace.funding_payments GROUP BY currency,status",
      )
    ).rows;
    const alerts = (
      await this.auth.pool.query(
        "SELECT kind,resource_id,created_at FROM workspace.operational_alerts ORDER BY created_at DESC LIMIT 100",
      )
    ).rows;
    const ledger = (
      await this.auth.pool.query(
        "SELECT currency,sum(debit)::numeric(30,6)::text AS deposited FROM runtime.ledger_lines WHERE account='asset:treasury:nowpayments' GROUP BY currency",
      )
    ).rows;
    const reconciliation = (["USDT", "USDC"] as const).map((currency) => {
      const expected = payments
        .filter((p) => p.currency === currency)
        .reduce((n, p) => n + units(p.credited, 6), 0n);
      const actual = ledger
        .filter((l) => l.currency === currency)
        .reduce((n, l) => n + units(l.deposited, 6), 0n);
      return {
        currency,
        matches: expected === actual,
        creditedUnits: expected.toString(),
        ledgerUnits: actual.toString(),
      };
    });
    return {
      payments,
      alerts,
      reconciliation,
      records: await this.list(account),
    };
  }
}
