import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { Funding, type FundsMode } from "./funding";
import { Auth, HttpError, type Account } from "./auth";
import { NowPayments } from "./nowpayments";
import { TronDeposits, type IncomingTransfer } from "./tron-deposits";
import { transfer } from "../../../packages/core/src/ledger";
import { decimal, units } from "../../../packages/core/src/money";
import {
  USDT_TRC20_RECEIVER,
  DEPOSIT_LIFETIME_MS,
} from "../../../packages/core/src/deposit-policy";
const DAY = 86400000;
export class DirectFunding extends Funding {
  private scanning = false;
  constructor(
    auth: Auth,
    provider: NowPayments,
    origin: string,
    mode: FundsMode,
    enabled: boolean,
    readonly chain = new TronDeposits(),
  ) {
    super(auth, provider, origin, mode, ["usdttrc20"], enabled);
  }
  override publicConfig() {
    return {
      ...super.publicConfig(),
      method: "exact_amount",
      receiver: USDT_TRC20_RECEIVER,
      creditPolicy: "received_amount",
      feeBearer: "sender_network_only",
      expiresInMinutes: 30,
    };
  }
  override async create(a: Account, input: unknown) {
    if (!this.enabled) throw new HttpError(503, "DEPOSITS_UNAVAILABLE");
    if (a.role !== "customer" || !a.customer_id)
      throw new HttpError(403, "FORBIDDEN");
    const v = z
      .object({
        currency: z.literal("USDT"),
        network: z.literal("usdttrc20"),
        amount: z.string().regex(/^(0|[1-9]\d{0,17})(\.\d{1,2})?$/),
        idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,100}$/),
      })
      .strict()
      .parse(input);
    const count = units(v.amount, 6);
    if (count <= 0n) throw new HttpError(400, "INVALID_AMOUNT");
    return this.auth.store.transactionWithClient(async (s, c) => {
      const old = (
        await c.query(
          "SELECT * FROM workspace.funding_payments WHERE account_id=$1 AND idempotency_key=$2",
          [a.id, v.idempotencyKey],
        )
      ).rows[0];
      if (old) {
        if (
          old.source !== "direct_tron" ||
          units(String(old.requested_amount), 6) !== count
        )
          throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
        return this.view(old);
      }
      if (
        !s.customers.some(
          (x) => x.id === a.customer_id && x.status === "approved",
        )
      )
        throw new HttpError(403, "CUSTOMER_NOT_APPROVED");
      const scan = (
        await c.query("SELECT * FROM workspace.direct_deposit_scan WHERE id=1")
      ).rows[0];
      if (
        !scan ||
        scan.receiver !== USDT_TRC20_RECEIVER ||
        this.auth.now() - new Date(scan.checked_at).getTime() > 120000 ||
        Number(scan.scanned_through) < this.auth.now() - 240000
      )
        throw new HttpError(503, "CHAIN_MONITOR_UNAVAILABLE");
      const used = new Set(
        (
          await c.query(
            "SELECT pay_amount FROM workspace.funding_payments WHERE source='direct_tron' AND pay_address=$1 AND pay_amount::numeric>$2::numeric AND pay_amount::numeric<$2::numeric+0.01",
            [USDT_TRC20_RECEIVER, decimal(count, 6)],
          )
        ).rows.map((r) => r.pay_amount),
      );
      const start = randomInt(1, 10000);
      let exact = "";
      for (let i = 0; i < 9999; i++) {
        const candidate = decimal(
          count + BigInt(1 + ((start - 1 + i) % 9999)),
          6,
        );
        if (!used.has(candidate)) {
          exact = candidate;
          break;
        }
      }
      if (!exact) throw new HttpError(409, "DEPOSIT_AMOUNT_BUSY");
      const id = "HTDEP-" + randomUUID(),
        at = new Date(this.auth.now()),
        expires = new Date(this.auth.now() + DEPOSIT_LIFETIME_MS);
      const row = (
        await c.query(
          "INSERT INTO workspace.funding_payments(id,account_id,customer_id,idempotency_key,currency,pay_currency,requested_amount,settlement_network,source,pay_address,pay_amount,status,expires_at,created_at) VALUES($1,$2,$3,$4,'USDT','usdttrc20',$5,'usdttrc20','direct_tron',$6,$7,'waiting',$8,$9) RETURNING *",
          [
            id,
            a.id,
            a.customer_id,
            v.idempotencyKey,
            decimal(count, 6),
            USDT_TRC20_RECEIVER,
            exact,
            expires,
            at,
          ],
        )
      ).rows[0];
      await this.auth.audit(c, "deposit.direct_created", a.id, id);
      return this.view(row);
    });
  }
  private async record(t: IncomingTransfer) {
    await this.auth.store.transactionWithClient(async (s, c) => {
      if (t.sourceHex === this.receiverHex) return;
      if (
        (
          await c.query(
            "SELECT 1 FROM workspace.chain_transfer_claims WHERE network='usdttrc20' AND txid=$1 AND log_index=$2",
            [t.txid, t.logIndex],
          )
        ).rows.length
      )
        return;
      await c.query(
        "INSERT INTO workspace.direct_deposit_events(txid,log_index,receiver,source_hex,amount,block_number,block_hash,block_time) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(txid,log_index) DO NOTHING",
        [
          t.txid,
          t.logIndex,
          USDT_TRC20_RECEIVER,
          t.sourceHex,
          t.amount,
          t.blockNumber,
          t.blockHash,
          new Date(t.time),
        ],
      );
      const r = (
        await c.query(
          "SELECT * FROM workspace.funding_payments WHERE source='direct_tron' AND pay_address=$1 AND pay_amount=$2 FOR UPDATE",
          [USDT_TRC20_RECEIVER, t.amount],
        )
      ).rows[0];
      const claimed = (
        await c.query(
          "SELECT payment_id FROM workspace.direct_deposit_claims WHERE txid=$1 AND log_index=$2",
          [t.txid, t.logIndex],
        )
      ).rows[0];
      if (claimed) return;
      const valid =
        r &&
        !r.journal_id &&
        t.time >= new Date(r.created_at).getTime() &&
        t.time <= new Date(r.expires_at).getTime() &&
        s.customers.some(
          (x) => x.id === r.customer_id && x.status === "approved",
        );
      if (valid) {
        await this.credit(s, c, r, t);
        return;
      }
      if (r && !r.journal_id)
        await c.query(
          "UPDATE workspace.funding_payments SET status='review',review_reason='TRANSFER_REQUIRES_REVIEW',updated_at=now() WHERE id=$1",
          [r.id],
        );
      await this.auth.audit(
        c,
        "deposit.unassigned_transfer",
        undefined,
        t.txid + ":" + t.logIndex,
      );
      await c.query(
        "INSERT INTO workspace.operational_alerts(id,kind,resource_id) VALUES($1,'deposit.unassigned_transfer',$2) ON CONFLICT(kind,resource_id) DO NOTHING",
        [randomUUID(), t.txid + ":" + t.logIndex],
      );
    });
  }
  private get receiverHex() {
    return addressHex("usdttrc20", USDT_TRC20_RECEIVER);
  }
  private async credit(s: any, c: any, r: any, t: IncomingTransfer) {
    await c.query(
      "INSERT INTO workspace.direct_deposit_claims(txid,log_index,payment_id) VALUES($1,$2,$3)",
      [t.txid, t.logIndex, r.id],
    );
    const j = transfer(
      s,
      `tron-deposit:${t.txid}:${t.logIndex}`,
      "USDT",
      t.amount,
      "asset:treasury:direct_tron",
      `liability:wallet:${r.customer_id}`,
      new Date(this.auth.now()),
    );
    await c.query(
      "UPDATE workspace.funding_payments SET status='credited',review_reason=NULL,credited_amount=$2,journal_id=$3,checked_at=now(),updated_at=now() WHERE id=$1",
      [r.id, t.amount, j.id],
    );
    s.audits.push({
      id: randomUUID(),
      actorId: "tron-monitor",
      action: "wallet.deposit_settled",
      targetId: r.customer_id,
      data: {
        paymentId: r.id,
        currency: "USDT",
        amount: t.amount,
        txid: t.txid,
        logIndex: t.logIndex,
      },
      at: new Date(this.auth.now()).toISOString(),
    });
    await this.auth.audit(c, "wallet.direct_deposit_settled", undefined, r.id);
  }
  override async tick() {
    if (this.scanning || !this.enabled) return;
    this.scanning = true;
    try {
      const solid = await this.chain.solidTime(),
        through = solid - 90000;
      await this.auth.pool.query(
        "INSERT INTO workspace.direct_deposit_scan(id,receiver,scanned_through,rescan_through) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO NOTHING",
        [USDT_TRC20_RECEIVER, through - 120000, through - 7 * DAY],
      );
      const cursor = (
        await this.auth.pool.query(
          "SELECT * FROM workspace.direct_deposit_scan WHERE id=1",
        )
      ).rows[0];
      if (cursor.receiver !== USDT_TRC20_RECEIVER)
        throw Error("Deposit receiver mismatch");
      const end = Math.min(through, Number(cursor.scanned_through) + 600000);
      if (end < Number(cursor.scanned_through))
        throw Error("Solidified scan cursor regressed");
      // Deliberate overlap handles eventual indexer visibility; a second 7-day sweep recovers delayed indexing.
      const ids = await this.chain.discover(
        Math.max(0, Number(cursor.scanned_through) - 300000),
        end,
      );
      for (const id of ids) await this.observe(id);
      await this.auth.pool.query(
        "UPDATE workspace.direct_deposit_scan SET scanned_through=GREATEST(scanned_through,$1),checked_at=now() WHERE id=1",
        [end],
      );
      const start =
        Number(cursor.rescan_through) < through - 7 * DAY ||
        Number(cursor.rescan_through) >= through
          ? through - 7 * DAY
          : Number(cursor.rescan_through);
      const recoveryEnd = Math.min(start + 3600000, through);
      for (const id of await this.chain.discover(start, recoveryEnd))
        await this.observe(id);
      await this.auth.pool.query(
        "UPDATE workspace.direct_deposit_scan SET rescan_through=$1 WHERE id=1",
        [recoveryEnd],
      );
      await this.auth.pool.query(
        "UPDATE workspace.funding_payments SET status='expired',updated_at=now() WHERE source='direct_tron' AND status='waiting' AND expires_at<now()",
      );
      // Legacy invoices remain reconciled, but new orders never call NOWPayments.
      await super.tick();
    } finally {
      this.scanning = false;
    }
  }
  private async observe(txid: string) {
    const exists = (
      await this.auth.pool.query(
        "SELECT 1 FROM workspace.direct_deposit_events WHERE txid=$1 LIMIT 1",
        [txid],
      )
    ).rows.length;
    if (exists) return;
    for (const t of await this.chain.verify(txid)) await this.record(t);
  }
  override async summary(a: Account) {
    const base = await super.summary(a);
    const scan =
      (
        await this.auth.pool.query(
          "SELECT scanned_through,checked_at FROM workspace.direct_deposit_scan WHERE id=1",
        )
      ).rows[0] ?? null;
    const unmatched = (
      await this.auth.pool.query(
        "SELECT e.txid,e.log_index,e.amount::text,e.block_time,e.block_number FROM workspace.direct_deposit_events e LEFT JOIN workspace.direct_deposit_claims c USING(txid,log_index) WHERE c.payment_id IS NULL ORDER BY e.block_time DESC LIMIT 100",
      )
    ).rows;
    return { ...base, receiver: USDT_TRC20_RECEIVER, scan, unmatched };
  }
  override async recheck(a: Account, id: string) {
    if (a.role !== "merchant_admin") throw new HttpError(403, "FORBIDDEN");
    const r = (
      await this.auth.pool.query(
        "SELECT source FROM workspace.funding_payments WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (r?.source !== "direct_tron") return super.recheck(a, id);
    await this.tick();
    return { ok: true };
  }
  override async resolve(a: Account, id: string, input: unknown) {
    if (a.role !== "merchant_admin") throw new HttpError(403, "FORBIDDEN");
    const row = (
      await this.auth.pool.query(
        "SELECT * FROM workspace.funding_payments WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (row?.source !== "direct_tron") return super.resolve(a, id, input);
    const v = z
      .object({
        decision: z.literal("assign_transfer"),
        txid: z.string().regex(/^[a-f0-9]{64}$/),
        logIndex: z.number().int().min(0),
        note: z.string().trim().min(10).max(500),
      })
      .strict()
      .parse(input);
    const t = (await this.chain.verify(v.txid)).find(
      (t) => t.logIndex === v.logIndex,
    );
    if (
      !t ||
      t.time < new Date(row.created_at).getTime() ||
      t.sourceHex === this.receiverHex
    )
      throw new HttpError(409, "TRANSFER_MISMATCH");
    await this.record(t);
    await this.auth.store.transactionWithClient(async (s, c) => {
      const r = (
        await c.query(
          "SELECT * FROM workspace.funding_payments WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      const claim = (
        await c.query(
          "SELECT payment_id FROM workspace.direct_deposit_claims WHERE txid=$1 AND log_index=$2",
          [v.txid, v.logIndex],
        )
      ).rows[0];
      if (claim?.payment_id === id) return;
      if (r.journal_id || claim)
        throw new HttpError(409, "TRANSFER_ALREADY_CLAIMED");
      // Never divert an exact match from another user's allocated order, even if expired.
      const other = (
        await c.query(
          "SELECT id FROM workspace.funding_payments WHERE source='direct_tron' AND pay_address=$1 AND pay_amount=$2 AND id<>$3",
          [USDT_TRC20_RECEIVER, t.amount, id],
        )
      ).rows[0];
      if (
        other ||
        !s.customers.some(
          (x) => x.id === r.customer_id && x.status === "approved",
        )
      )
        throw new HttpError(409, "TRANSFER_MISMATCH");
      await this.credit(s, c, r, t);
      await c.query(
        "INSERT INTO workspace.funding_reviews(id,payment_id,actor_id,decision,note) VALUES($1,$2,$3,'assign_transfer',$4)",
        [randomUUID(), id, a.id, v.note],
      );
      await this.auth.audit(c, "deposit.transfer_assigned", a.id, id);
    });
    return { ok: true };
  }
}
import { addressHex } from "./chain-transfers";
