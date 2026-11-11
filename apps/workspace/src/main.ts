import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isIP } from "node:net";
import { Pool } from "pg";
import { initializeWorkspace } from "./database";
import { Auth } from "./auth";
import { workspaceApp } from "./app";
import { PrivateFiles } from "./files";

async function main() {
  const { WORKSPACE_DATABASE_URL, WORKSPACE_ORIGIN, WORKSPACE_RECEIPT_DIR } =
    process.env;
  if (!WORKSPACE_DATABASE_URL || !WORKSPACE_ORIGIN || !WORKSPACE_RECEIPT_DIR)
    throw new Error("Workspace configuration missing");
  const pool = new Pool({
    connectionString: WORKSPACE_DATABASE_URL,
    max: 10,
    statement_timeout: 15_000,
  });
  pool.on("error", () =>
    console.error("Workspace database connection unavailable"),
  );
  const store = await initializeWorkspace(pool);
  const app = workspaceApp(
    new Auth(pool, store),
    new PrivateFiles(WORKSPACE_RECEIPT_DIR),
    WORKSPACE_ORIGIN,
  );
  const server = createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith("/") || req.url.startsWith("//")) {
        res.writeHead(400);
        res.end();
        return;
      }
      const url = new URL(req.url, WORKSPACE_ORIGIN);
      if (
        (url.pathname === "/workspace" || url.pathname === "/workspace/") &&
        ["GET", "HEAD"].includes(req.method ?? "")
      ) {
        const html = await readFile(
          resolve(
            process.env.WORKSPACE_CLIENT_DIR ?? "sites-dist/client",
            "workspace.html",
          ),
        );
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-frame-options": "DENY",
          "x-content-type-options": "nosniff",
          "referrer-policy": "same-origin",
        });
        res.end(req.method === "HEAD" ? undefined : html);
        return;
      }
      if (!url.pathname.startsWith("/workspace/api/")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 3 * 1024 * 1024) {
          res.writeHead(413, { "cache-control": "no-store" });
          res.end();
          return;
        }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (
          [
            "host",
            "connection",
            "transfer-encoding",
            "content-length",
          ].includes(key)
        )
          continue;
        if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
        else if (value !== undefined) headers.set(key, value);
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        ...(size ? { body: Buffer.concat(chunks) } : {}),
      });
      // Proxy must overwrite X-Real-IP. Trust only loopback opt-in or one configured proxy IP.
      const remote = req.socket.remoteAddress ?? "unknown";
      const realIp = req.headers["x-real-ip"];
      const trustedProxy =
        (process.env.WORKSPACE_TRUST_LOOPBACK_PROXY === "true" &&
          ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) ||
        (isIP(process.env.WORKSPACE_TRUSTED_PROXY_IP ?? "") !== 0 &&
          remote === process.env.WORKSPACE_TRUSTED_PROXY_IP);
      const ip =
        trustedProxy && typeof realIp === "string" && isIP(realIp) !== 0
          ? realIp
          : remote;
      const response = await app(request, ip);
      const output = Object.fromEntries(response.headers) as Record<
        string,
        string | string[]
      >;
      if (response.headers.getSetCookie().length)
        output["set-cookie"] = response.headers.getSetCookie();
      output["x-frame-options"] = "DENY";
      res.writeHead(response.status, output);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(500, { "cache-control": "no-store" });
      res.end();
    }
  });
  server.on("error", () => {
    console.error("Workspace listener failed");
    void pool.end().finally(() => {
      process.exitCode = 1;
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  // Binding remains local; TLS and public routing belong to the reverse proxy.
  const host = process.env.WORKSPACE_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "172.18.0.1"].includes(host))
    throw new Error(
      "Workspace must bind to a local or configured Docker bridge interface",
    );
  server.listen(Number(process.env.WORKSPACE_PORT ?? 4182), host, () =>
    console.log("Workspace account beta ready; funds sandbox"),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () =>
      server.close(() => {
        void pool.end();
      }),
    );
}
void main().catch(() => {
  console.error(
    "Workspace startup failed; check configuration and migrations privately",
  );
  process.exitCode = 1;
});
