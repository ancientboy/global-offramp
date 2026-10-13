import { Pool } from "pg";
import { Queue, Worker } from "bullmq";
import { assertSafeRuntime } from "../../../packages/core/src/security";
assertSafeRuntime(process.env);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const connection = {
  host: process.env.REDIS_HOST ?? "127.0.0.1",
  port: Number(process.env.REDIS_PORT ?? 6379),
};
const queue = new Queue("offramp-events", { connection });
let stopping = false;
// Jobs deliver internal mock notifications only. There is deliberately no money executor.
const worker = new Worker(
  "offramp-events",
  async (job) => {
    await pool.query(
      "INSERT INTO runtime.consumer_events(event_id) VALUES($1) ON CONFLICT DO NOTHING",
      [job.id],
    );
  },
  { connection, concurrency: 4 },
);
async function pump() {
  while (!stopping) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const rows = await c.query(
        "SELECT * FROM runtime.outbox WHERE delivered_at IS NULL ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 50",
      );
      for (const e of rows.rows) {
        await queue.add(
          e.topic,
          { eventId: e.id, aggregateId: e.aggregate_id, payload: e.payload },
          {
            jobId: e.id,
            attempts: 5,
            backoff: { type: "exponential", delay: 1000 },
            removeOnComplete: false,
          },
        );
        await c.query(
          "UPDATE runtime.outbox SET delivered_at=now() WHERE id=$1",
          [e.id],
        );
      }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      console.error("Outbox relay failed; transaction retained for retry");
    } finally {
      c.release();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
async function stop() {
  stopping = true;
  await worker.close();
  await queue.close();
  await pool.end();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
void pump();
