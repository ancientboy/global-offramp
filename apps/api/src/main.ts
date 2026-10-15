import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { Pool } from "pg";
import { makeAppModule } from "./app";
import { MemoryStore, PostgresStore } from "../../../packages/core/src/store";
import { assertSafeRuntime } from "../../../packages/core/src/security";
async function main() {
  assertSafeRuntime(process.env);
  const durable = process.env.STORAGE_MODE === "postgres";
  const store = durable
    ? new PostgresStore(
        new Pool({ connectionString: process.env.DATABASE_URL }),
      )
    : new MemoryStore();
  if (store instanceof PostgresStore) await store.initialize();
  const app = await NestFactory.create<NestExpressApplication>(
    makeAppModule(store),
    { rawBody: true },
  );
  app.useBodyParser("json", { limit: "3mb" });
  app.use(helmet());
  app.enableCors({
    origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3000",
    allowedHeaders: ["Content-Type", "x-demo-actor"],
    methods: ["GET", "POST"],
  });
  app.enableShutdownHooks();
  await app.listen(
    Number(process.env.PORT ?? 3001),
    process.env.HOST ?? "127.0.0.1",
  );
  console.log(
    `MOCK ONLY API on ${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 3001}; ${durable ? "PostgreSQL" : "volatile memory"} storage`,
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : "Startup failed");
  process.exit(1);
});
