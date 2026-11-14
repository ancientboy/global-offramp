import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { Auth } from "./auth";
import { PostgresStore } from "../../../packages/core/src/store";

async function main() {
  const command = process.argv[2];
  if (
    !["migrate", "create-admin"].includes(command) ||
    process.argv.length !== 3
  )
    throw new Error("Use migrate or create-admin; credentials only via stdin");
  const url =
    command === "migrate"
      ? process.env.WORKSPACE_MIGRATION_DATABASE_URL
      : process.env.WORKSPACE_DATABASE_URL;
  if (!url) throw new Error("Database configuration missing");
  const pool = new Pool({ connectionString: url });
  try {
    if (command === "migrate") {
      await pool.query(readFileSync("db-runtime.sql", "utf8"));
      await pool.query(readFileSync("db/migrations/002_workspace.sql", "utf8"));
      await pool.query(
        readFileSync("db/migrations/003_route_drafts.sql", "utf8"),
      );
      // The earlier two-role identity constraint is superseded by migration 006.
      const providerSchema = await pool.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema='workspace' AND table_name='accounts' AND column_name='payout_provider_id'",
      );
      if (!providerSchema.rowCount)
        await pool.query(
          readFileSync(
            "db/migrations/004_operator_customer_username.sql",
            "utf8",
          ),
        );
      await pool.query(
        readFileSync("db/migrations/005_multi_fiat.sql", "utf8"),
      );
      const partnerSchema = await pool.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema='workspace' AND table_name='accounts' AND column_name='partner_id'",
      );
      if (!partnerSchema.rowCount)
        await pool.query(
          readFileSync("db/migrations/006_provider_accounts.sql", "utf8"),
        );
      await pool.query(
        readFileSync("db/migrations/007_partner_invites.sql", "utf8"),
      );
      await pool.query(
        readFileSync("db/migrations/008_funding_security.sql", "utf8"),
      );
      await pool.query(
        readFileSync(
          "db/migrations/009_funding_observation_sequence.sql",
          "utf8",
        ),
      );
      await pool.query(
        readFileSync("db/migrations/010_money_movements.sql", "utf8"),
      );
      await pool.query(
        readFileSync("db/migrations/011_deposit_cost_quotes.sql", "utf8"),
      );
      console.log("Workspace schemas installed; no demo database touched");
    } else {
      // Piped JSON from a protected terminal prompt or secret manager; never argv/env/log.
      if (process.stdin.isTTY)
        throw new Error(
          "Pipe JSON {username,name,password} via stdin from a hidden password prompt",
        );
      let raw = "";
      for await (const chunk of process.stdin) {
        raw += chunk;
        if (raw.length > 4096) throw new Error("Input too large");
      }
      const input = JSON.parse(raw);
      await new Auth(pool, new PostgresStore(pool)).createAdmin(
        { username: input.username, password: input.password },
        input.name,
      );
      console.log("Administrator created; no session or password emitted");
    }
  } finally {
    await pool.end();
  }
}
void main().catch(() => {
  console.error(
    "Workspace CLI failed; inspect configuration/input privately (duplicate email is rejected)",
  );
  process.exitCode = 1;
});
