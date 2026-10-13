import { Pool } from "pg";
import { readFileSync } from "node:fs";
async function main() {
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await p.query(readFileSync("db-runtime.sql", "utf8"));
    console.log(
      "Runtime schema installed (mock MVP). Normalized reference schema is a separate migration.",
    );
  } finally {
    await p.end();
  }
}
void main();
