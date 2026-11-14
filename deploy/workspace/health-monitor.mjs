import { readFile, readdir, stat, statfs } from "node:fs/promises";
import { Pool } from "pg";
const pool = new Pool({
  connectionString: process.env.WORKSPACE_DATABASE_URL,
  max: 1,
  statement_timeout: 10000,
});
let failed = false;
async function alert(kind) {
  failed = true;
  await pool.query(
    "INSERT INTO workspace.operational_alerts(id,kind,resource_id) VALUES($1,$2,$3) ON CONFLICT(kind,resource_id) DO NOTHING",
    [crypto.randomUUID(), kind, new Date().toISOString().slice(0, 10)],
  );
  console.error(kind);
}
try {
  const r = await fetch("http://172.18.0.1:4182/workspace/api/health", {
    signal: AbortSignal.timeout(5000),
  });
  if (!r.ok || (await r.json()).status !== "ok")
    await alert("health.application_unavailable");
  try {
    const liveEnv = await readFile(
        "/etc/global-offramp/live/runtime.env",
        "utf8",
      ),
      line = liveEnv
        .split(/\r?\n/)
        .find((v) => v.startsWith("WORKSPACE_DATABASE_URL="));
    if (line) {
      const response = await fetch(
          "http://172.18.0.1:4183/workspace/api/health",
          { signal: AbortSignal.timeout(5000) },
        ),
        h = await response.json();
      if (
        !response.ok ||
        h.status !== "ok" ||
        h.fundsMode !== "live" ||
        h.simulatedTopupsEnabled
      )
        await alert("live.application_unavailable");
      const livePool = new Pool({
        connectionString: line.slice("WORKSPACE_DATABASE_URL=".length),
        max: 1,
        statement_timeout: 10000,
      });
      try {
        const mismatch = await livePool.query(
          `SELECT COALESCE(p.currency,l.currency) currency FROM (SELECT currency,sum(credited_amount) n FROM workspace.funding_payments GROUP BY currency) p FULL JOIN (SELECT currency,sum(debit) n FROM runtime.ledger_lines WHERE account='asset:treasury:nowpayments' GROUP BY currency) l USING(currency) WHERE COALESCE(p.n,0)<>COALESCE(l.n,0)`,
        );
        if (mismatch.rows.length) await alert("live.funding.ledger_mismatch");
        const held = await livePool.query(
          `SELECT COALESCE(m.currency,l.currency) currency FROM (SELECT currency,sum(amount) n FROM workspace.money_movements WHERE status IN ('requested','approved') GROUP BY currency) m FULL JOIN (SELECT currency,sum(credit-debit) n FROM runtime.ledger_lines WHERE account LIKE 'liability:movement:%' GROUP BY currency) l USING(currency) WHERE COALESCE(m.n,0)<>COALESCE(l.n,0)`,
        );
        if (held.rows.length) await alert("live.money.reservation_mismatch");
      } finally {
        await livePool.end();
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") await alert("live.monitor_unavailable");
  }
  const root = "/var/backups/global-offramp/business",
    dirs = await readdir(root);
  const times = [];
  for (const d of dirs) {
    try {
      const s = await stat(root + "/" + d + "/SHA256SUMS");
      times.push(s.mtimeMs);
    } catch {}
  }
  if (!times.length || Date.now() - Math.max(...times) > 8 * 3600000)
    await alert("backup.snapshot_stale");
  const disk = await statfs(root);
  if (disk.bavail / disk.blocks < 0.1) await alert("storage.disk_low");
  const mismatches = await pool.query(
    `SELECT p.currency FROM (SELECT currency,sum(credited_amount) amount FROM workspace.funding_payments GROUP BY currency) p FULL JOIN (SELECT currency,sum(debit) amount FROM runtime.ledger_lines WHERE account='asset:treasury:nowpayments' GROUP BY currency) l USING(currency) WHERE COALESCE(p.amount,0)<>COALESCE(l.amount,0)`,
  );
  if (mismatches.rows.length) await alert("funding.ledger_mismatch");
  const pending = await pool.query(
    "SELECT count(*)::int AS n FROM workspace.funding_payments WHERE provider_id IS NOT NULL AND (checked_at IS NULL OR checked_at<now()-interval '1 hour') AND created_at<now()-interval '1 hour'",
  );
  if (pending.rows[0].n) await alert("funding.reconciliation_stale");
  const movementMismatch = await pool.query(
    `SELECT COALESCE(m.currency,l.currency) currency FROM (SELECT currency,sum(amount) held FROM workspace.money_movements WHERE status IN ('requested','approved') GROUP BY currency) m FULL JOIN (SELECT currency,sum(credit-debit) held FROM runtime.ledger_lines WHERE account LIKE 'liability:movement:%' GROUP BY currency) l USING(currency) WHERE COALESCE(m.held,0)<>COALESCE(l.held,0)`,
  );
  if (movementMismatch.rows.length) await alert("money.reservation_mismatch");
  const movementStale = await pool.query(
    "SELECT count(*)::int AS n FROM workspace.money_movements WHERE status IN ('requested','approved') AND updated_at<now()-interval '24 hours'",
  );
  if (movementStale.rows[0].n) await alert("money.pending_stale");
  if (process.env.OFFRAMP_OFFSITE_ENABLED === "true") {
    let last = 0;
    try {
      last = Date.parse(
        (
          await readFile(
            "/var/lib/global-offramp-workspace/offsite-last-success",
            "utf8",
          )
        ).trim(),
      );
    } catch {}
    if (!last || Date.now() - last > 8 * 3600000)
      await alert("backup.offsite_stale");
  }
  if (!failed)
    console.log("Application, backups and deposit ledger checks passed");
} catch {
  failed = true;
  console.error("Operational health check failed");
} finally {
  await pool.end();
  process.exitCode = failed ? 1 : 0;
}
