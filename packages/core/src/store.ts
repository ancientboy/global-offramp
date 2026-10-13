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
  for (const order of previous.orders) {
    const newer = next.orders.find((o) => o.id === order.id);
    demand(
      newer && JSON.stringify(order.quote) === JSON.stringify(newer.quote),
      "IMMUTABLE_QUOTE",
      "Order quote snapshots cannot change",
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
      const value = await work(next);
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
