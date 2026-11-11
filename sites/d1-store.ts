/** Synthetic-only, identity-scoped snapshot storage. Never a production money ledger.
 * Each command callback must be side-effect free: CAS conflicts replay it.
 * A single atomic SQL update commits the whole core transaction, including its
 * idempotency records, journal, wallet and outbox. Never retry an uncertain write.
 */
import { fixtureState } from "../packages/core/src/fixtures";
import { assertAppendOnly } from "../packages/core/src/store";
import { demand } from "../packages/core/src/money";
import type { State, Store } from "../packages/core/src/types";
export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<{ success: boolean; meta: { changes?: number } }>;
}
export interface D1Database {
  prepare(sql: string): D1Statement;
}
interface Row {
  revision: number;
  document: string;
}
export const D1_MAX_STATE_BYTES = 1024 * 1024; // Below D1's 2 MB row/string limit.
export class D1MockStore implements Store {
  constructor(
    private readonly db: D1Database,
    private readonly owner: string,
    private readonly byteLimit = D1_MAX_STATE_BYTES,
  ) {
    demand(
      owner.length > 0 && owner.length <= 256,
      "UNAUTHENTICATED",
      "A signed-in Site visitor is required",
    );
  }
  private async load(): Promise<Row> {
    let row = await this.db
      .prepare(
        "SELECT revision, document FROM offramp_mock_state WHERE owner_id = ?",
      )
      .bind(this.owner)
      .first<Row>();
    if (!row) {
      const result = await this.db
        .prepare(
          "INSERT INTO offramp_mock_state (owner_id, revision, document) VALUES (?, 0, ?) ON CONFLICT(owner_id) DO NOTHING",
        )
        .bind(this.owner, JSON.stringify(fixtureState()))
        .run();
      demand(
        result.success,
        "STORAGE_UNAVAILABLE",
        "Synthetic history storage is unavailable",
      );
      row = await this.db
        .prepare(
          "SELECT revision, document FROM offramp_mock_state WHERE owner_id = ?",
        )
        .bind(this.owner)
        .first<Row>();
    }
    demand(
      row,
      "STORAGE_UNAVAILABLE",
      "Synthetic history storage is unavailable",
    );
    return row;
  }
  async read(): Promise<State> {
    return JSON.parse((await this.load()).document) as State;
  }
  async transaction<T>(work: (state: State) => T | Promise<T>): Promise<T> {
    for (let retry = 0; retry < 12; retry++) {
      const row = await this.load();
      const before = JSON.parse(row.document) as State;
      const draft = structuredClone(before);
      const value = await work(draft);
      assertAppendOnly(before, draft);
      const document = JSON.stringify(draft);
      demand(
        new TextEncoder().encode(document).byteLength <= this.byteLimit,
        "STORAGE_CAPACITY",
        "Synthetic history capacity reached; existing records are preserved",
      );
      // A successful conditional update is the linearization point across isolates.
      // If run() throws its outcome is uncertain: propagate, never replay here.
      const result = await this.db
        .prepare(
          "UPDATE offramp_mock_state SET document = ?, revision = revision + 1 WHERE owner_id = ? AND revision = ?",
        )
        .bind(document, this.owner, row.revision)
        .run();
      demand(
        result.success,
        "STORAGE_UNAVAILABLE",
        "Synthetic history storage is unavailable",
      );
      if (result.meta.changes === 1) return structuredClone(value);
      demand(
        result.meta.changes === 0,
        "STORAGE_UNAVAILABLE",
        "Uncertain synthetic history write outcome",
      );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(2 ** retry, 64)),
      );
    }
    demand(
      false,
      "STORAGE_BUSY",
      "Synthetic history changed concurrently; retry the same command",
    );
  }
  async health(): Promise<boolean> {
    try {
      await this.db
        .prepare(
          "SELECT revision, document FROM offramp_mock_state WHERE owner_id = ?",
        )
        .bind(this.owner)
        .first<Row>();
      return true;
    } catch {
      return false;
    }
  }
}
