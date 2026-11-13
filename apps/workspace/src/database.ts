import { PostgresStore, type SqlPool } from "../../../packages/core/src/store";
import { fixtureState } from "../../../packages/core/src/fixtures";
/** Fail closed on missing migrations or a mistakenly selected legacy/demo database. */
export async function initializeWorkspace(pool: SqlPool) {
  await pool.query("SELECT id FROM workspace.accounts LIMIT 0");
  const store = new PostgresStore(pool);
  const empty = fixtureState();
  empty.customers = [];
  empty.beneficiaries = [];
  await store.initialize(empty);
  const state = await store.read();
  const registered = new Set(
    (await pool.query("SELECT id FROM workspace.customers")).rows.map(
      (r) => r.id,
    ),
  );
  if (state.customers.some((c) => !registered.has(c.id)))
    throw new Error(
      "Workspace database contains unbound legacy/demo customers; use a dedicated database",
    );
  const attributions = await pool.query(
    "SELECT customer_id,partner_id FROM workspace.customer_attributions",
  );
  if (
    attributions.rows.some(
      (row) =>
        !state.customers.some(
          (c) => c.id === row.customer_id && c.partnerId === row.partner_id,
        ),
    )
  )
    throw new Error(
      "Workspace customer attribution does not match the immutable registry",
    );
  return store;
}
