import { State, Store } from "./types";
import { fixtureState } from "./fixtures";
import { demand } from "./money";
export function assertAppendOnly(previous: State, next: State): void {
  for (const name of [
    "journals",
    "audits",
    "quotes",
    "webhookEvents",
    "outbox",
  ] as const) {
    demand(
      next[name].length >= previous[name].length,
      "IMMUTABLE_RECORD",
      `${name} cannot be deleted`,
    );
    for (let i = 0; i < previous[name].length; i++)
      demand(
        JSON.stringify(previous[name][i]) === JSON.stringify(next[name][i]),
        "IMMUTABLE_RECORD",
        `${name} cannot be rewritten`,
      );
  }
  const priorReceipts = previous.privateReceipts ?? [];
  const nextReceipts = next.privateReceipts ?? [];
  demand(
    nextReceipts.length >= priorReceipts.length,
    "IMMUTABLE_RECORD",
    "Receipt originals cannot be deleted",
  );
  for (let i = 0; i < priorReceipts.length; i++) {
    const prior = priorReceipts[i];
    const current = nextReceipts[i];
    const {
      recognition: _beforeRecognition,
      kind: beforeKind,
      quarantine: beforeQuarantine,
      links: beforeLinks,
      published: beforePublished,
      batchPublished: beforeBatchPublished,
      ...beforeIdentity
    } = prior;
    const {
      recognition: _afterRecognition,
      kind: afterKind,
      quarantine: afterQuarantine,
      links: afterLinks,
      published: afterPublished,
      batchPublished: afterBatchPublished,
      ...afterIdentity
    } = current;
    demand(
      beforeKind === afterKind ||
        (beforeKind === "single" &&
          afterKind === "batch" &&
          (!beforePublished || !!afterQuarantine)),
      "IMMUTABLE_RECORD",
      "Receipt classification cannot become less private",
    );
    demand(
      !beforeQuarantine ||
        JSON.stringify(beforeQuarantine) === JSON.stringify(afterQuarantine),
      "IMMUTABLE_RECORD",
      "Receipt quarantine cannot be removed or rewritten",
    );
    demand(
      JSON.stringify(beforeIdentity) === JSON.stringify(afterIdentity),
      "IMMUTABLE_RECORD",
      "Receipt original identity cannot be rewritten",
    );
    demand(
      afterLinks.length >= beforeLinks.length &&
        beforeLinks.every(
          (link, j) => JSON.stringify(link) === JSON.stringify(afterLinks[j]),
        ),
      "IMMUTABLE_RECORD",
      "Receipt associations cannot be deleted or rewritten",
    );
    demand(
      !beforeBatchPublished ||
        JSON.stringify(beforeBatchPublished) ===
          JSON.stringify(afterBatchPublished),
      "IMMUTABLE_RECORD",
      "Published batch grants cannot be deleted or rewritten",
    );
    demand(
      !beforePublished ||
        JSON.stringify(beforePublished) === JSON.stringify(afterPublished),
      "IMMUTABLE_RECORD",
      "Published receipt grants cannot be deleted or rewritten",
    );
  }
  const priorPricing = previous.pricingHistory ?? [];
  demand(
    (next.pricingHistory ?? []).length >= priorPricing.length &&
      priorPricing.every(
        (v, i) => JSON.stringify(v) === JSON.stringify(next.pricingHistory![i]),
      ),
    "IMMUTABLE_RECORD",
    "Published pricing cannot be rewritten",
  );
  for (const order of previous.orders) {
    const newer = next.orders.find((o) => o.id === order.id);
    demand(
      newer && JSON.stringify(order.quote) === JSON.stringify(newer.quote),
      "IMMUTABLE_QUOTE",
      "Order quote snapshots cannot change",
    );
    demand(
      (order.receiptAttachmentIds ?? []).every(
        (id, i) => newer.receiptAttachmentIds?.[i] === id,
      ),
      "IMMUTABLE_RECORD",
      "Order receipt associations cannot be removed or rewritten",
    );
    demand(
      newer.orderNumber === order.orderNumber &&
        JSON.stringify(newer.payoutProviderSnapshot) ===
          JSON.stringify(order.payoutProviderSnapshot),
      "IMMUTABLE_PROVIDER",
      "Order number and payout provider snapshots cannot change",
    );
  }
}
/** Deterministic test/demo adapter. Never use as durable storage. Serializes writes. */
export class MemoryStore implements Store {
  private state: State;
  private tail: Promise<void> = Promise.resolve();
  constructor(initial: State = fixtureState()) {
    this.state = structuredClone(initial);
  }
  async transaction<T>(work: (s: State) => T | Promise<T>): Promise<T> {
    const before = this.tail;
    let release!: () => void;
    this.tail = new Promise((r) => (release = r));
    await before;
    try {
      const draft = structuredClone(this.state);
      const result = await work(draft);
      assertAppendOnly(this.state, draft);
      this.state = draft;
      return structuredClone(result);
    } finally {
      release();
    }
  }
  async read() {
    await this.tail;
    return structuredClone(this.state);
  }
  async health() {
    return true;
  }
}
export interface SqlClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  release?(): void;
}
export interface SqlPool {
  connect(): Promise<SqlClient>;
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}
/** Mock MVP persistence. Global row lock favors correctness over throughput. See ADR. */
export class PostgresStore implements Store {
  constructor(private pool: SqlPool) {}
  async initialize(initial: State = fixtureState()) {
    await this.pool.query(
      "INSERT INTO runtime.state (id, document) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING",
      [JSON.stringify(initial)],
    );
  }
  async transaction<T>(work: (s: State) => T | Promise<T>): Promise<T> {
    return this.transactionWithClient((s) => work(s));
  }
  /** Enrollment uses this same DB transaction for the account and business customer. */
  async transactionWithClient<T>(
    work: (s: State, c: SqlClient) => T | Promise<T>,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await c.query(
        "SELECT document FROM runtime.state WHERE id=1 FOR UPDATE",
      );
      demand(
        result.rows.length === 1,
        "NOT_INITIALIZED",
        "Run migration and initialize store",
      );
      const prior = result.rows[0].document as State;
      const next = structuredClone(prior);
      const value = await work(next, c);
      assertAppendOnly(prior, next);
      for (const journal of next.journals.slice(prior.journals.length)) {
        await c.query(
          "INSERT INTO runtime.journals(id,business_key,reversal_of,created_at) VALUES($1,$2,$3,$4)",
          [
            journal.id,
            journal.businessKey,
            journal.reversalOf ?? null,
            journal.createdAt,
          ],
        );
        for (const line of journal.lines)
          await c.query(
            "INSERT INTO runtime.ledger_lines(journal_id,account,currency,debit,credit) VALUES($1,$2,$3,$4,$5)",
            [journal.id, line.account, line.currency, line.debit, line.credit],
          );
      }
      for (const event of next.outbox.slice(prior.outbox.length))
        await c.query(
          "INSERT INTO runtime.outbox(id,topic,aggregate_id,payload,created_at) VALUES($1,$2,$3,$4::jsonb,$5)",
          [
            event.id,
            event.topic,
            event.aggregateId,
            JSON.stringify(event.payload),
            event.createdAt,
          ],
        );
      for (const audit of next.audits.slice(prior.audits.length))
        await c.query(
          "INSERT INTO runtime.audit(id,actor_id,action,target_id,data,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
          [
            audit.id,
            audit.actorId,
            audit.action,
            audit.targetId,
            JSON.stringify(audit.data),
            audit.at,
          ],
        );
      await c.query(
        "UPDATE runtime.state SET document=$1::jsonb, version=version+1 WHERE id=1",
        [JSON.stringify(next)],
      );
      await c.query("COMMIT");
      return structuredClone(value);
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release?.();
    }
  }
  async read(): Promise<State> {
    const r = await this.pool.query(
      "SELECT document FROM runtime.state WHERE id=1",
    );
    demand(r.rows[0], "NOT_INITIALIZED", "Store missing");
    return r.rows[0].document as State;
  }
  async health() {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }
}
