import {
  publicInvitation,
  listPartners,
  createPartner,
  setPartnerStatus,
  partnerDashboard,
} from "./partners";
import { DomainError } from "../../../packages/core/src/money";
import { providerDashboard, providerOrder } from "./providers";
import { ZodError } from "zod";
import { Auth, actorFor, HttpError, publicAccount } from "./auth";
import { OfframpService } from "../../../packages/core/src/service";
import { routeCatalog, saveRouteDraft, validateRouteRecipient } from "./routes";
import { MarketRatesService, MarketRateError } from "./market-rates";
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
// The shared adapter omits execution commands. Provider payment records use a separate
// scoped namespace below; no bank or blockchain execution is wired.
const businessRoutes = [
  ["GET", /^\/(dashboard|audit|receipts)$/],
  ["GET", /^\/(orders|batches)\/[\w-]+\/published-receipts$/],
  ["GET", /^\/(published-receipts|receipts)\/[\w-]+\/download$/],
  ["GET", /^\/orders\/[\w-]+\/receipt-file$/],
  ["POST", /^\/admin\/pricing\/(preview|publish)$/],
  ["POST", /^\/admin\/payout-providers$/],
  ["POST", /^\/settlements$/],
  ["POST", /^\/settlements\/[\w-]+\/(approve|cancel)$/],
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
  options: {
    enableSimulatedTopups?: boolean;
    marketRates?: MarketRatesService;
  } = {},
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
      const body = async (limit = 4096) => {
        const text = await request.text();
        if (Buffer.byteLength(text) > limit)
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
            simulatedTopupsEnabled: options.enableSimulatedTopups === true,
          },
          healthy ? 200 : 503,
        );
      }
      const inviteMatch = /^\/invites\/([A-Za-z0-9_-]{1,100})$/.exec(path);
      if (request.method === "GET" && inviteMatch) {
        await auth.rate("invite:" + ip, 60, 60000);
        return json(await publicInvitation(auth, inviteMatch[1]));
      }
      if (request.method === "POST" && path === "/auth/register") {
        await auth.rate("register:" + ip, 5, 60 * 60_000);
        return json({ account: await auth.register(await body()) }, 201);
      }
      if (request.method === "GET" && path === "/public-market-rates") {
        if (!options.marketRates)
          throw new HttpError(503, "REFERENCE_UNAVAILABLE");
        const { snapshot, stale, expiresAt } =
          await options.marketRates.status();
        return json({ snapshot, stale, expiresAt });
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
      if (
        path === "/admin/partners" ||
        /^\/admin\/partners\/[a-zA-Z0-9_-]+\/status$/.test(path)
      ) {
        if (account.role !== "merchant_admin")
          throw new HttpError(403, "FORBIDDEN");
        if (path === "/admin/partners" && request.method === "GET")
          return json({ partners: await listPartners(auth, account, origin) });
        if (path === "/admin/partners" && request.method === "POST") {
          await auth.rate("partner-create:" + account.id, 10, 60000);
          return json(
            {
              partner: await createPartner(auth, account, origin, await body()),
            },
            201,
          );
        }
        const statusMatch =
          /^\/admin\/partners\/([a-zA-Z0-9_-]+)\/status$/.exec(path);
        if (statusMatch && request.method === "POST")
          return json(
            await setPartnerStatus(auth, account, statusMatch[1], await body()),
          );
        throw new HttpError(405, "METHOD_NOT_ALLOWED");
      }
      if (account.role === "partner") {
        if (path === "/dashboard" && request.method === "GET")
          return json(await partnerDashboard(auth, account, origin));
        throw new HttpError(403, "FORBIDDEN");
      }
      // Dedicated service-provider identities never enter the broad business command adapter.
      if (account.role === "payout_provider") {
        if (request.method === "GET" && path === "/dashboard")
          return json(await providerDashboard(auth, account));
        const match =
          /^\/provider\/orders\/([a-zA-Z0-9_-]{1,100})(?:\/(payment|receipt))?$/.exec(
            path,
          );
        if (match) {
          const [, id, action] = match;
          await providerOrder(auth, account, id);
          if (request.method === "GET" && !action)
            return json(await providerOrder(auth, account, id));
          if (request.method === "GET" && action === "receipt") {
            const file = await core.downloadReceiptFile(actorFor(account), id);
            return new Response(Buffer.from(file.dataBase64, "base64"), {
              headers: {
                "content-type": file.contentType,
                "content-disposition":
                  "attachment; filename*=UTF-8''" +
                  encodeURIComponent(file.fileName),
                "cache-control": "private, no-store",
                "x-content-type-options": "nosniff",
              },
            });
          }
          if (
            request.method === "POST" &&
            (action === "payment" || action === "receipt")
          ) {
            await auth.rate("provider-write:" + account.id, 20, 60000);
            if (action === "payment")
              await core.confirmManualPayout(
                actorFor(account),
                id,
                await body(),
              );
            else
              await core.uploadReceiptFile(
                actorFor(account),
                id,
                await body(3 * 1024 * 1024),
              );
            return json(await providerOrder(auth, account, id));
          }
        }
        throw new HttpError(403, "FORBIDDEN");
      }
      if (request.method === "GET" && path === "/market-rates") {
        if (!options.marketRates)
          throw new HttpError(503, "REFERENCE_UNAVAILABLE");
        return json(await options.marketRates.status());
      }
      if (request.method === "POST" && path === "/market-rates/refresh") {
        if (account.role !== "merchant_admin")
          throw new HttpError(403, "FORBIDDEN");
        if (!options.marketRates)
          throw new HttpError(503, "REFERENCE_UNAVAILABLE");
        await auth.rate("market-refresh:" + account.id, 3, 60000);
        if (Object.keys(await body()).length)
          throw new HttpError(400, "INVALID_INPUT");
        return json(await options.marketRates.refresh());
      }
      let forwarded = request;
      if (options.marketRates && request.method === "POST") {
        if (path === "/quotes" || /^\/batches\/[\w-]+\/quote$/.test(path))
          await options.marketRates.baseline();
        if (/^\/admin\/pricing\/(preview|publish)$/.test(path)) {
          if (account.role !== "merchant_admin")
            throw new HttpError(403, "FORBIDDEN");
          const input = await body();
          input.baseline = await options.marketRates.baseline();
          forwarded = new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: JSON.stringify(input),
          });
        }
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
        request.method === "POST" &&
        path === "/wallet/deposits" &&
        !options.enableSimulatedTopups
      )
        throw new HttpError(403, "SIMULATED_TOPUPS_DISABLED");
      if (
        !businessRoutes.some(
          ([method, pattern]) =>
            method === request.method && pattern.test(path),
        ) &&
        !(
          request.method === "POST" &&
          path === "/wallet/deposits" &&
          options.enableSimulatedTopups
        )
      )
        throw new HttpError(403, "SANDBOX_ROUTE_DISABLED");
      // One stable private namespace for this workspace DB, independent from demo identities.
      const translated = new URL(request.url);
      translated.pathname = "/api" + path;
      const result = await dispatchBusinessCommand({
        request: new Request(translated, forwarded),
        core,
        actor: actorFor(account),
        bucket,
        owner: "workspace-v1",
        now: auth.now,
      });
      if (
        path === "/dashboard" &&
        request.method === "GET" &&
        account.role === "merchant_admin" &&
        result.ok
      ) {
        const data = await result.json();
        return json({
          ...data,
          partners: (await listPartners(auth, account, origin)).map((p) => ({
            id: p.id,
            name: p.name,
            status: p.status,
          })),
        });
      }
      // The shared adapter has its own safe domain errors; no auth internals are returned.
      return result;
    } catch (error) {
      if (error instanceof MarketRateError)
        return json(
          { error: error.code, message: "参考汇率暂不可用，请稍后重试。" },
          503,
        );
      if (error instanceof DomainError)
        return json(
          { error: error.code },
          error.code === "FORBIDDEN"
            ? 403
            : error.code === "NOT_FOUND"
              ? 404
              : 409,
        );
      if (error instanceof HttpError)
        return json({ error: error.code }, error.status);
      if (error instanceof ZodError || error instanceof SyntaxError)
        return json({ error: "INVALID_INPUT" }, 400);
      return json({ error: "INTERNAL_ERROR" }, 500);
    }
  };
}
