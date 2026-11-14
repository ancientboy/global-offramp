import { OfframpService } from "../../../packages/core/src/service";
import type { Funding } from "./funding";
import { initialProviders } from "../../../packages/core/src/pricing";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Auth, HttpError, actorFor, type Account } from "./auth";
import {
  ChainTransfers,
  address,
  TRON_USDT,
  BASE_USDC,
  type TransferNetwork,
} from "./chain-transfers";
import { transfer } from "../../../packages/core/src/ledger";
import { decimal, units } from "../../../packages/core/src/money";
import type { State } from "../../../packages/core/src/types";
const inputSchema = z
  .object({
    currency: z.enum(["USDT", "USDC"]),
    network: z.enum(["usdttrc20", "usdcbase"]),
    amount: z.string().regex(/^\d{1,7}(\.\d{1,6})?$/),
    destination: z.string().trim().max(100),
    reason: z.string().trim().min(3).max(300),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
    providerId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .optional(),
  })
  .strict();
export class MoneyMovements {
  constructor(
    readonly auth: Auth,
    readonly chain: ChainTransfers,
    readonly mode: "sandbox" | "live",
    readonly maxAmount = "1000",
    readonly dailyLimit = "5000",
  ) {}
  private admin(a: Account) {
    if (a.role !== "merchant_admin") throw new HttpError(403, "FORBIDDEN");
  }
  private held(id: string) {
    return "liability:movement:" + id;
  }
  private balance(s: State, account: string, currency: "USDT" | "USDC") {
    return s.journals
      .flatMap((j) => j.lines)
      .filter((l) => l.account === account && l.currency === currency)
      .reduce((n, l) => n + units(l.credit, 6) - units(l.debit, 6), 0n);
  }
  private owner(a: Account, row: any) {
    if (
      a.role !== "merchant_admin" &&
      !(
        a.role === "customer" &&
        row.kind === "refund" &&
        row.customer_id === a.customer_id
      )
    )
      throw new HttpError(404, "NOT_FOUND");
  }
  private source(r: any) {
    return r.kind === "refund"
      ? "liability:wallet:" + r.customer_id
      : "liability:provider-settlement:" + r.provider_id;
  }
  private async event(
    c: any,
    a: Account,
    id: string,
    action: string,
    note: string,
  ) {
    await c.query(
      "INSERT INTO workspace.money_movement_events(id,movement_id,actor_id,action,note) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(), id, a.id, action, note],
    );
  }
  async list(a: Account, reader: Pick<Auth["pool"], "query"> = this.auth.pool) {
    if (!["customer", "merchant_admin", "payout_provider"].includes(a.role))
      throw new HttpError(403, "FORBIDDEN");
    const rows = (
      await reader.query(
        "SELECT m.id,m.kind,m.customer_id,m.provider_id,m.currency,m.network,m.amount::text,m.destination,m.reason,m.status,m.created_at,m.approved_at,m.updated_at,c.txid,c.log_index FROM workspace.money_movements m LEFT JOIN workspace.chain_transfer_claims c ON c.movement_id=m.id WHERE ($1='merchant_admin' OR ($1='customer' AND m.customer_id=$2 AND m.kind='refund') OR ($1='payout_provider' AND m.provider_id=$3 AND m.kind='provider_settlement')) ORDER BY m.created_at DESC LIMIT 100",
        [a.role, a.customer_id, a.payout_provider_id ?? null],
      )
    ).rows;
    return rows;
  }
  async create(
    a: Account,
    kind: "refund" | "provider_settlement",
    input: unknown,
  ) {
    if (kind === "refund") {
      if (a.role !== "customer" || !a.customer_id)
        throw new HttpError(403, "FORBIDDEN");
    } else this.admin(a);
    const v = inputSchema.parse(input);
    if ((v.network === "usdttrc20" ? "USDT" : "USDC") !== v.currency)
      throw new HttpError(400, "UNSUPPORTED_NETWORK");
    if (kind === "refund" && v.providerId)
      throw new HttpError(400, "INVALID_INPUT");
    if (kind === "provider_settlement" && !v.providerId)
      throw new HttpError(400, "PROVIDER_REQUIRED");
    const destination = address(v.network, v.destination),
      value = units(v.amount, 6),
      amount = decimal(value, 6);
    if (
      destination === (v.network === "usdttrc20" ? TRON_USDT : BASE_USDC) ||
      this.chain.treasury[v.network].includes(destination)
    )
      throw new HttpError(400, "INVALID_WALLET_ADDRESS");
    if (value <= 0n || value > units(this.maxAmount, 6))
      throw new HttpError(400, "MOVEMENT_LIMIT_EXCEEDED");
    return this.auth.store.transactionWithClient(async (s, c) => {
      const prior = (
        await c.query(
          "SELECT * FROM workspace.money_movements WHERE requested_by=$1 AND idempotency_key=$2",
          [a.id, v.idempotencyKey],
        )
      ).rows[0];
      if (prior) {
        if (
          prior.kind !== kind ||
          prior.currency !== v.currency ||
          prior.network !== v.network ||
          prior.destination !== destination ||
          units(String(prior.amount), 6) !== value ||
          (prior.provider_id ?? undefined) !== v.providerId ||
          prior.reason !== v.reason
        )
          throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
        return this.view(prior);
      }
      if (
        kind === "refund" &&
        !s.customers.some(
          (x) => x.id === a.customer_id && x.status === "approved",
        )
      )
        throw new HttpError(403, "CUSTOMER_BLOCKED");
      if (
        kind === "provider_settlement" &&
        !(s.payoutProviders ?? initialProviders()).some(
          (p) => p.id === v.providerId && p.status === "active",
        )
      )
        throw new HttpError(400, "PROVIDER_UNAVAILABLE");
      const total = (
        await c.query(
          "SELECT COALESCE(sum(amount),0)::text AS total FROM workspace.money_movements WHERE requested_by=$1 AND created_at>$2 AND status NOT IN ('cancelled','rejected')",
          [a.id, new Date(this.auth.now() - 86400000)],
        )
      ).rows[0].total;
      if (units(total, 6) + value > units(this.dailyLimit, 6))
        throw new HttpError(429, "DAILY_MOVEMENT_LIMIT");
      const id = "HTMOVE-" + randomUUID(),
        row = {
          id,
          kind,
          customer_id: kind === "refund" ? a.customer_id : null,
          provider_id: v.providerId ?? null,
          currency: v.currency,
        };
      const source = this.source(row);
      if (this.balance(s, source, v.currency) < value)
        throw new HttpError(
          409,
          kind === "refund"
            ? "INSUFFICIENT_BALANCE"
            : "INSUFFICIENT_PROVIDER_PAYABLE",
        );
      const j = transfer(
        s,
        "movement-reserve:" + id,
        v.currency,
        amount,
        source,
        this.held(id),
        new Date(this.auth.now()),
      );
      const saved = (
        await c.query(
          "INSERT INTO workspace.money_movements(id,kind,customer_id,provider_id,currency,network,amount,destination,requested_by,idempotency_key,reason,status,reserve_journal) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'requested',$12) RETURNING *",
          [
            id,
            kind,
            row.customer_id,
            row.provider_id,
            v.currency,
            v.network,
            amount,
            destination,
            a.id,
            v.idempotencyKey,
            v.reason,
            j.id,
          ],
        )
      ).rows[0];
      await this.event(c, a, id, "requested", v.reason);
      return this.view(saved);
    });
  }
  private view(r: any) {
    return {
      id: r.id,
      kind: r.kind,
      currency: r.currency,
      network: r.network,
      amount: String(r.amount),
      destination: r.destination,
      status: r.status,
      created_at: r.created_at,
    };
  }
  async decide(a: Account, id: string, input: unknown) {
    const v = z
      .object({
        action: z.enum(["approve", "reject", "cancel"]),
        note: z.string().trim().min(3).max(300),
      })
      .strict()
      .parse(input);
    if (v.action !== "cancel") this.admin(a);
    return this.auth.store.transactionWithClient(async (s, c) => {
      const r = (
        await c.query(
          "SELECT * FROM workspace.money_movements WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!r) throw new HttpError(404, "NOT_FOUND");
      this.owner(a, r);
      const target = {
        approve: "approved",
        reject: "rejected",
        cancel: "cancelled",
      }[v.action];
      if (r.status === target) return this.view(r);
      if (r.status !== "requested") throw new HttpError(409, "MOVEMENT_LOCKED");
      if (v.action === "approve") {
        if (
          r.customer_id &&
          !s.customers.some(
            (x) => x.id === r.customer_id && x.status === "approved",
          )
        )
          throw new HttpError(403, "CUSTOMER_BLOCKED");
        await c.query(
          "UPDATE workspace.money_movements SET status='approved',approved_by=$2,approved_at=$3,updated_at=now() WHERE id=$1",
          [id, a.id, new Date(this.auth.now())],
        );
      } else {
        if (
          this.balance(s, this.held(id), r.currency) !==
          units(String(r.amount), 6)
        )
          throw new HttpError(409, "MOVEMENT_RESERVATION_MISMATCH");
        const j = transfer(
          s,
          "movement-release:" + id,
          r.currency,
          String(r.amount),
          this.held(id),
          this.source(r),
          new Date(this.auth.now()),
        );
        await c.query(
          "UPDATE workspace.money_movements SET status=$2,closing_journal=$3,updated_at=now() WHERE id=$1",
          [id, target, j.id],
        );
      }
      await this.event(c, a, id, target, v.note);
      return { ...this.view(r), status: target };
    });
  }
  async complete(a: Account, id: string, input: unknown) {
    this.admin(a);
    if (this.mode !== "live") throw new HttpError(403, "REAL_FUNDS_DISABLED");
    const v = z
      .object({
        txid: z.string().max(66),
        logIndex: z.number().int().min(0).max(2147483647).optional(),
      })
      .strict()
      .parse(input);
    const r = (
      await this.auth.pool.query(
        "SELECT * FROM workspace.money_movements WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!r) throw new HttpError(404, "NOT_FOUND");
    if (r.status === "completed") return this.completedRetry(id, v);
    if (r.status !== "approved")
      throw new HttpError(409, "MOVEMENT_NOT_APPROVED");
    const proof = await this.chain.verify(
      {
        network: r.network as TransferNetwork,
        destination: r.destination,
        amount: String(r.amount),
        approvedAt: r.approved_at,
      },
      v,
    );
    return this.auth.store
      .transactionWithClient(async (s, c) => {
        const locked = (
          await c.query(
            "SELECT * FROM workspace.money_movements WHERE id=$1 FOR UPDATE",
            [id],
          )
        ).rows[0];
        if (locked.status === "completed") return this.completedRetry(id, v, c);
        if (locked.status !== "approved")
          throw new HttpError(409, "MOVEMENT_LOCKED");
        if (
          this.balance(s, this.held(id), r.currency) !==
          units(String(r.amount), 6)
        )
          throw new HttpError(409, "MOVEMENT_RESERVATION_MISMATCH");
        await c.query(
          "INSERT INTO workspace.chain_transfer_claims(network,txid,log_index,movement_id,block_number,block_hash,source_address) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            proof.network,
            proof.txid,
            proof.logIndex,
            id,
            proof.blockNumber,
            proof.blockHash,
            proof.sourceAddress,
          ],
        );
        const j = transfer(
          s,
          "movement-paid:" + id,
          r.currency,
          String(r.amount),
          this.held(id),
          "asset:treasury:nowpayments",
          new Date(this.auth.now()),
        );
        await c.query(
          "UPDATE workspace.money_movements SET status='completed',closing_journal=$2,updated_at=now() WHERE id=$1",
          [id, j.id],
        );
        await this.event(
          c,
          a,
          id,
          "chain_verified",
          proof.network + ":" + proof.txid + ":" + proof.logIndex,
        );
        return { id, status: "completed" };
      })
      .catch((e) => {
        if (e.code === "23505")
          throw new HttpError(409, "TRANSFER_ALREADY_CLAIMED");
        throw e;
      });
  }
  private async completedRetry(
    id: string,
    v: { txid: string; logIndex?: number },
    c: Pick<Auth["pool"], "query"> = this.auth.pool,
  ) {
    const p = (
      await c.query(
        "SELECT txid,log_index FROM workspace.chain_transfer_claims WHERE movement_id=$1",
        [id],
      )
    ).rows[0];
    if (
      p?.txid !== v.txid.toLowerCase() ||
      (v.logIndex !== undefined && p?.log_index !== v.logIndex)
    )
      throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
    return { id, status: "completed" };
  }
  async detail(a: Account, id: string) {
    this.admin(a);
    const record = (
      await this.auth.pool.query(
        "SELECT m.id,m.kind,m.customer_id,m.provider_id,m.currency,m.network,m.amount::text,m.destination,m.reason,m.status,m.created_at,m.approved_at,c.txid,c.log_index FROM workspace.money_movements m LEFT JOIN workspace.chain_transfer_claims c ON c.movement_id=m.id WHERE m.id=$1",
        [id],
      )
    ).rows[0];
    if (!record) throw new HttpError(404, "NOT_FOUND");
    const events = (
      await this.auth.pool.query(
        "SELECT e.action,e.note,e.created_at,a.display_name AS actor_name FROM workspace.money_movement_events e JOIN workspace.accounts a ON a.id=e.actor_id WHERE e.movement_id=$1 ORDER BY e.created_at,e.id",
        [id],
      )
    ).rows;
    return { ...record, events };
  }
  async adminSummary(a: Account) {
    this.admin(a);
    const state = await this.auth.store.read();
    const payables = (state.payoutProviders ?? initialProviders()).flatMap(
      (p) =>
        (["USDT", "USDC"] as const).map((currency) => ({
          providerId: p.id,
          name: p.name,
          currency,
          available: decimal(
            this.balance(
              state,
              "liability:provider-settlement:" + p.id,
              currency,
            ),
            6,
          ),
        })),
    );
    return {
      records: await this.list(a),
      payables,
      verification: this.chain.config(),
    };
  }
  async customerDashboard(a: Account, funding?: Funding) {
    if (a.role !== "customer" || !a.customer_id)
      throw new HttpError(403, "FORBIDDEN");
    const c = await this.auth.pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = (
        await c.query("SELECT document FROM runtime.state WHERE id=1")
      ).rows[0]?.document as State;
      if (!state) throw new HttpError(503, "NOT_INITIALIZED");
      const core = new OfframpService(
        {
          read: async () => structuredClone(state),
          health: async () => true,
          transaction: async () => {
            throw Error("Read-only snapshot");
          },
        },
        () => new Date(this.auth.now()),
      );
      const data = await core.dashboard(actorFor(a), { readOnly: true }),
        moneyMovements = await this.list(a, c);
      // Aggregate all holds in SQL, even when the display list is capped at 100 records.
      const totals = (
        await c.query(
          "SELECT currency,sum(amount)::text AS amount FROM workspace.money_movements WHERE customer_id=$1 AND kind='refund' AND status IN ('requested','approved') GROUP BY currency",
          [a.customer_id],
        )
      ).rows;
      const result = {
        ...data,
        storageMode: "postgres",
        storageLimits: null,
        moneyMovements,
        fundingPayments: funding ? await funding.list(a, c) : [],
        walletBalances: data.walletBalances!.map((b) => ({
          ...b,
          frozen: decimal(
            units(b.frozen, 6) +
              totals
                .filter((t) => t.currency === b.currency)
                .reduce((n, t) => n + units(t.amount, 6), 0n),
            6,
          ),
        })),
      };
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release?.();
    }
  }
  async refundsHeld(a: Account) {
    if (a.role !== "customer") return [];
    return (
      await this.auth.pool.query(
        "SELECT currency,sum(amount)::text AS amount FROM workspace.money_movements WHERE customer_id=$1 AND kind='refund' AND status IN ('requested','approved') GROUP BY currency",
        [a.customer_id],
      )
    ).rows;
  }
}
