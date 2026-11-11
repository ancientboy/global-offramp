import { ZodError } from "zod";
import { Auth, actorFor, HttpError, publicAccount } from "./auth";
import { OfframpService } from "../../../packages/core/src/service";
import { routeCatalog, saveRouteDraft, validateRouteRecipient } from "./routes";
import {
  dispatchBusinessCommand,
  type ReceiptBucket,
} from "../../../sites/worker";

export const COOKIE = "__Secure-offramp-workspace";
const cookiePath = "/workspace/api";
const cookie = (token: string, seconds: number) =>
  `${COOKIE}=${token}; Path=${cookiePath}; Max-Age=${seconds}; HttpOnly; Secure; SameSite=Strict`;
function tokenOf(r: Request) {
  const parts = (r.headers.get("cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(COOKIE + "="));
  const token = parts.length === 1 ? parts[0].slice(COOKIE.length + 1) : "";
  return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
function json(body: unknown, status = 200, setCookie?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    vary: "Cookie",
    "x-workspace-mode": "ACCOUNT_BETA_FUNDS_SANDBOX",
  };
  if (setCookie) headers["set-cookie"] = setCookie;
  if (status === 429) headers["retry-after"] = "60";
  return new Response(JSON.stringify(body), { status, headers });
}
// Intentionally omit all money/deposit/completion/provider-execution commands, including
// manual payment attestation. Real channels are not wired. New routes default to denied.
const businessRoutes = [
  ["GET", /^\/(dashboard|audit|receipts)$/],
  ["GET", /^\/(orders|batches)\/[\w-]+\/published-receipts$/],
  ["GET", /^\/(published-receipts|receipts)\/[\w-]+\/download$/],
  ["GET", /^\/orders\/[\w-]+\/receipt-file$/],
  ["POST", /^\/admin\/pricing\/(preview|publish)$/],
  ["POST", /^\/admin\/payout-providers$/],
  ["POST", /^\/customers\/[\w-]+\/review$/],
  ["POST", /^\/(beneficiaries|quotes|orders|batches|batches\/merchant)$/],
  ["POST", /^\/beneficiaries\/[\w-]+\/approve$/],
  ["POST", /^\/orders\/[\w-]+\/cancel$/],
  ["POST", /^\/batches\/[\w-]+\/(quote|submit)$/],
  ["POST", /^\/receipts\/upload$/],
  ["POST", /^\/receipts\/[\w-]+\/(recognition|link|publish|publish-batch)$/],
] as const;
export function workspaceApp(
  auth: Auth,
  bucket: ReceiptBucket,
  origin: string,
) {
  if (new URL(origin).origin !== origin || !origin.startsWith("https://"))
    throw new Error("WORKSPACE_ORIGIN must be an HTTPS origin");
  const core = new OfframpService(auth.store, () => new Date(auth.now()));
  return async (request: Request, ip: string): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.origin !== origin || !url.pathname.startsWith("/workspace/api/"))
        throw new HttpError(404, "NOT_FOUND");
      if (!["GET", "POST"].includes(request.method))
        throw new HttpError(405, "METHOD_NOT_ALLOWED");
      const site = request.headers.get("sec-fetch-site");
      if (
        (site && site !== "same-origin") ||
        (request.method === "POST" && request.headers.get("origin") !== origin)
      )
        throw new HttpError(403, "CSRF_REJECTED");
      if (
        request.method === "POST" &&
        request.headers.get("content-type")?.split(";")[0].trim() !==
          "application/json"
      )
        throw new HttpError(415, "JSON_REQUIRED");
      // Never trust identity/role/proxy headers from callers.
      await auth.rate("requests:" + ip, 300, 60_000);
      const path = url.pathname.slice("/workspace/api".length);
      const body = async () => {
        const text = await request.text();
        if (Buffer.byteLength(text) > 4096)
          throw new HttpError(413, "BODY_TOO_LARGE");
        return JSON.parse(text);
      };
      if (request.method === "GET" && path === "/health") {
        const healthy = await auth.store.health();
        return json(
          {
            status: healthy ? "ok" : "unavailable",
            mode: "MOCK",
            persistence: "postgres",
            realExecutionEnabled: false,
            accountMode: "beta",
            emailVerified: false,
            mfaEnabled: false,
          },
          healthy ? 200 : 503,
        );
      }
      if (request.method === "POST" && path === "/auth/register") {
        await auth.rate("register:" + ip, 5, 60 * 60_000);
        return json({ account: await auth.register(await body()) }, 201);
      }
      if (request.method === "POST" && path === "/auth/login") {
        const value = await auth.login(await body(), ip);
        return json(
          { account: value.account },
          200,
          cookie(value.token, 8 * 60 * 60),
        );
      }
      const token = tokenOf(request);
      const account = await auth.current(token);
      if (request.method === "GET" && path === "/auth/me")
        return json({ account: publicAccount(account) });
      if (request.method === "POST" && path === "/auth/logout") {
        await auth.logout(token!, account);
        return json({ loggedOut: true }, 200, cookie("", 0));
      }
      if (request.method === "GET" && path === "/routes")
        return json(await routeCatalog(auth, account));
      const routeMatch =
        /^\/routes\/(USDT|USDC)-(CNY|USD|EUR|MXN|BRL|GBP)\/(draft|validate-recipient)$/.exec(
          path,
        );
      if (request.method === "POST" && routeMatch) {
        const id = routeMatch[1] + "-" + routeMatch[2];
        return json(
          routeMatch[3] === "draft"
            ? await saveRouteDraft(auth, account, id, await body())
            : validateRouteRecipient(id, await body()),
        );
      }
      if (
        !businessRoutes.some(
          ([method, pattern]) =>
            method === request.method && pattern.test(path),
        )
      )
        throw new HttpError(403, "SANDBOX_ROUTE_DISABLED");
      // One stable private namespace for this workspace DB, independent from demo identities.
      const translated = new URL(request.url);
      translated.pathname = "/api" + path;
      const result = await dispatchBusinessCommand({
        request: new Request(translated, request),
        core,
        actor: actorFor(account),
        bucket,
        owner: "workspace-v1",
        now: auth.now,
      });
      // The shared adapter has its own safe domain errors; no auth internals are returned.
      return result;
    } catch (error) {
      if (error instanceof HttpError)
        return json({ error: error.code }, error.status);
      if (error instanceof ZodError || error instanceof SyntaxError)
        return json({ error: "INVALID_INPUT" }, 400);
      return json({ error: "INTERNAL_ERROR" }, 500);
    }
  };
}
