import {
  financeSnapshot,
  financePage,
  financeCsv,
  financeFilters,
  customerPage,
} from "./admin-finance";
import { financialReport, reportCsv } from "./financial-report";
import { MoneyMovements } from "./money-movements";
import { ReceiptScanner } from "./receipt-scanner";
import { AccountSecurity } from "./account-security";
import { Funding, type FundsMode } from "./funding";
import { randomUUID } from "node:crypto";
import {
  validateFullRecipient,
  type FullRecipientInput,
} from "../../../packages/core/src/recipient-account";
import { RecipientVault } from "./recipient-vault";
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
    recipientVault?: RecipientVault;
    security?: AccountSecurity;
    scanner?: ReceiptScanner;
    funding?: Funding;
    money?: MoneyMovements;
    fundsMode?: FundsMode;
    usdtOnly?: boolean;
    payoutsPaused?: boolean;
  } = {},
) {
  if (new URL(origin).origin !== origin || !origin.startsWith("https://"))
    throw new Error("WORKSPACE_ORIGIN must be an HTTPS origin");
  const core = new OfframpService(
    auth.store,
    () => new Date(auth.now()),
    undefined,
    options.fundsMode === "live" ? "live" : "mock",
    options.fundsMode === "live" || !!options.money,
  );
  return async (request: Request, ip: string): Promise<Response> => {
    try {
      const url = new URL(request.url);
      if (url.origin !== origin || !url.pathname.startsWith("/workspace/api/"))
        throw new HttpError(404, "NOT_FOUND");
      if (!["GET", "POST"].includes(request.method))
        throw new HttpError(405, "METHOD_NOT_ALLOWED");
      if (
        url.pathname === "/workspace/api/payments/nowpayments/ipn" &&
        request.method === "POST"
      ) {
        if (!options.funding?.enabled)
          throw new HttpError(503, "DEPOSITS_UNAVAILABLE");
        await auth.rate("nowpayments-ipn:" + ip, 120, 60000);
        return json(
          await options.funding.ipn(
            await request.text(),
            request.headers.get("x-nowpayments-sig"),
          ),
        );
      }
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
            mfaEnabled: !!options.security,
            receiptScanningEnabled: !!options.scanner,
            fundsMode: options.fundsMode ?? "sandbox",
            depositsEnabled: !!options.funding?.enabled,
            moneyOperationsEnabled: !!options.money,
            payoutsPaused: options.payoutsPaused ?? false,
            simulatedTopupsEnabled: options.enableSimulatedTopups === true,
            recipientAccountsEnabled: !!options.recipientVault,
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
      if (path.startsWith("/admin/") && account.role !== "merchant_admin")
        throw new HttpError(403, "FORBIDDEN");
      if (path === "/auth/security" && request.method === "GET") {
        if (!options.security) throw new HttpError(503, "SECURITY_UNAVAILABLE");
        return json({
          ...(await options.security.status(account)),
          enforced: options.fundsMode === "live",
        });
      }
      if (path.startsWith("/auth/security/") && request.method === "POST") {
        if (!options.security) throw new HttpError(503, "SECURITY_UNAVAILABLE");
        await auth.rate("security:" + account.id, 10, 15 * 60000);
        const input = await body();
        if (path.endsWith("/password"))
          return json(await options.security.password(account, input, token!));
        if (path.endsWith("/setup"))
          return json(await options.security.setup(account, input));
        if (path.endsWith("/confirm"))
          return json(await options.security.confirm(account, input, token!));
        if (path.endsWith("/verify"))
          return json(await options.security.stepUp(account, input, token!));
        throw new HttpError(404, "NOT_FOUND");
      }
      if (
        options.fundsMode === "live" &&
        !["/auth/me", "/auth/logout"].includes(path)
      ) {
        if (!options.security) throw new HttpError(503, "SECURITY_UNAVAILABLE");
        await options.security.requireReady(
          account,
          token!,
          request.method === "POST",
        );
        if (
          options.payoutsPaused &&
          request.method === "POST" &&
          (path === "/orders" ||
            /^\/admin\/money\/[\w-]+\/verify$/.test(path) ||
            /^\/provider\/orders\/[\w-]+\/payment$/.test(path) ||
            /^\/batches\/[\w-]+\/submit$/.test(path) ||
            path === "/settlements" ||
            /^\/settlements\/[\w-]+\/approve$/.test(path))
        )
          throw new HttpError(503, "PAYOUTS_PAUSED");
      }
      if (
        options.fundsMode === "live" &&
        request.method === "POST" &&
        path.startsWith("/settlements")
      )
        throw new HttpError(403, "REAL_SETTLEMENT_NOT_CONFIGURED");
      if (path === "/admin/finance/transactions" && request.method === "GET") {
        financeFilters(url.searchParams);
        const result = financePage(
          await financeSnapshot(auth, account),
          url.searchParams,
        );
        if (url.searchParams.get("format") === "csv")
          return new Response(financeCsv(result), {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition":
                "attachment; filename=financial-transactions.csv",
              "cache-control": "private, no-store",
              "x-content-type-options": "nosniff",
            },
          });
        return json(result);
      }
      if (path === "/admin/customers" && request.method === "GET")
        return json(
          customerPage(await financeSnapshot(auth, account), url.searchParams),
        );
      const customerDetail = /^\/admin\/customers\/([^/]+)$/.exec(path);
      if (customerDetail && request.method === "GET") {
        const snapshot = await financeSnapshot(auth, account),
          id = decodeURIComponent(customerDetail[1]),
          person = snapshot.people.find((p) => p.id === id);
        if (!person) throw new HttpError(404, "NOT_FOUND");
        return json({
          asOf: snapshot.asOf,
          customer: person,
          recipients: snapshot.beneficiaries.filter((b) => b.customerId === id),
        });
      }
      const movementDetails = /^\/admin\/money\/(HTMOVE-[a-zA-Z0-9-]+)$/.exec(
        path,
      );
      if (movementDetails && request.method === "GET") {
        if (!options.money)
          throw new HttpError(503, "MONEY_OPERATIONS_UNAVAILABLE");
        return json(await options.money.detail(account, movementDetails[1]));
      }
      if (path === "/admin/money/report" && request.method === "GET") {
        const report = await financialReport(auth, account);
        if (url.searchParams.get("format") === "csv")
          return new Response(reportCsv(report), {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition":
                "attachment; filename=financial-reconciliation.csv",
              "cache-control": "private, no-store",
              "x-content-type-options": "nosniff",
            },
          });
        return json(report);
      }
      if (
        path === "/wallet/refunds" ||
        path === "/money-movements" ||
        path === "/admin/money" ||
        path === "/admin/provider-settlements" ||
        /^\/(?:money-movements|admin\/money)\/HTMOVE-[a-zA-Z0-9-]+\/(decision|verify)$/.test(
          path,
        )
      ) {
        if (!options.money)
          throw new HttpError(503, "MONEY_OPERATIONS_UNAVAILABLE");
        if (path === "/wallet/refunds" && account.role !== "customer")
          throw new HttpError(403, "FORBIDDEN");
        if (
          path === "/wallet/refunds" &&
          request.method === "POST" &&
          options.fundsMode === "live"
        )
          await options.security!.requireRecentMfa(account, token!);
        if (request.method === "GET") {
          if (path === "/admin/money")
            return json(
              await options.money.adminSummary(account, url.searchParams),
            );
          if (path === "/wallet/refunds" || path === "/money-movements")
            return json({ records: await options.money.list(account) });
          throw new HttpError(404, "NOT_FOUND");
        }
        await auth.rate("money-operation:" + account.id, 10, 60000);
        if (path === "/wallet/refunds")
          return json(
            await options.money.create(account, "refund", await body()),
            201,
          );
        if (path === "/admin/provider-settlements")
          return json(
            await options.money.create(
              account,
              "provider_settlement",
              await body(),
            ),
            201,
          );
        const movement =
          /^\/(?:money-movements|admin\/money)\/(HTMOVE-[a-zA-Z0-9-]+)\/(decision|verify)$/.exec(
            path,
          );
        if (movement) {
          const input = await body();
          if (movement[2] === "verify")
            return json(
              await options.money.complete(account, movement[1], input),
            );
          if (
            options.fundsMode === "live" &&
            options.payoutsPaused &&
            input.action === "approve"
          )
            throw new HttpError(503, "PAYOUTS_PAUSED");
          return json(await options.money.decide(account, movement[1], input));
        }
        throw new HttpError(405, "METHOD_NOT_ALLOWED");
      }
      if (path === "/wallet/funding" && request.method === "GET")
        return json(
          options.funding?.publicConfig() ?? { enabled: false, networks: [] },
        );
      if (path === "/wallet/funding/payments") {
        if (!options.funding) throw new HttpError(503, "DEPOSITS_UNAVAILABLE");
        if (request.method === "GET")
          return json({ payments: await options.funding.list(account) });
        await auth.rate("deposit-create:" + account.id, 3, 60000);
        return json(await options.funding.create(account, await body()), 201);
      }
      const fundingReview =
        /^\/admin\/funding\/(HTDEP-[a-zA-Z0-9-]+)\/resolve$/.exec(path);
      if (fundingReview && request.method === "POST") {
        if (!options.funding) throw new HttpError(503, "DEPOSITS_UNAVAILABLE");
        await auth.rate("funding-review:" + account.id, 5, 60000);
        return json(
          await options.funding.resolve(
            account,
            fundingReview[1],
            await body(),
          ),
        );
      }
      const fundingRecheck =
        /^\/admin\/funding\/(HTDEP-[a-zA-Z0-9-]+)\/recheck$/.exec(path);
      if (fundingRecheck && request.method === "POST") {
        if (!options.funding) throw new HttpError(503, "DEPOSITS_UNAVAILABLE");
        await auth.rate("funding-recheck:" + account.id, 5, 60000);
        return json(await options.funding.recheck(account, fundingRecheck[1]));
      }
      if (path === "/admin/funding" && request.method === "GET") {
        if (!options.funding) throw new HttpError(503, "DEPOSITS_UNAVAILABLE");
        return json(await options.funding.summary(account));
      }
      if (
        path === "/dashboard" &&
        request.method === "GET" &&
        account.role === "customer" &&
        options.money
      )
        return json(
          await options.money.customerDashboard(account, options.funding),
        );
      if (
        path === "/beneficiaries" &&
        request.method === "POST" &&
        options.recipientVault
      ) {
        if (!["customer", "merchant_admin"].includes(account.role))
          throw new HttpError(403, "FORBIDDEN");
        const input = await body(8192);
        if (
          !input ||
          Object.keys(input).some(
            (k) =>
              ![
                "country",
                "currency",
                "method",
                "fields",
                "customerId",
              ].includes(k),
          ) ||
          !input.fields ||
          typeof input.fields !== "object" ||
          Array.isArray(input.fields)
        )
          throw new HttpError(400, "RECIPIENT_DETAILS_REQUIRED");
        const validation = validateFullRecipient(input as FullRecipientInput);
        if (!validation.valid)
          return json(
            { error: "INVALID_RECIPIENT", fields: validation.errors },
            400,
          );
        const customerId =
          account.role === "customer" ? account.customer_id : input.customerId;
        if (!customerId) throw new HttpError(400, "INVALID_INPUT");
        if (
          account.role === "customer" &&
          input.customerId &&
          input.customerId !== customerId
        )
          throw new HttpError(403, "FORBIDDEN");
        const accountToken = "recipient-" + randomUUID(),
          scope = {
            customerId,
            country: input.country,
            currency: input.currency,
            accountToken,
          };
        const normalized = {
          ...input,
          fields: validation.fields,
        } as FullRecipientInput;
        const primary =
          validation.fields.accountNumber ??
          validation.fields.iban ??
          validation.fields.clabe ??
          validation.fields.pixKey;
        const tail = (primary?.replace(/\D/g, "").slice(-4) || "").padStart(
          4,
          "0",
        );
        const b = await core.createBeneficiary(actorFor(account), {
          ...scope,
          name: validation.fields.accountHolderName,
          accountMasked:
            "**** " +
            (input.method === "BR_PIX" &&
            ["email", "random"].includes(validation.fields.pixKeyType)
              ? "PIX"
              : tail),
          ...(validation.fields.bankName
            ? { bankName: validation.fields.bankName }
            : {}),
          recipientAccount: {
            method: input.method,
            encrypted: options.recipientVault.seal(scope, normalized),
            boundAt: new Date(auth.now()).toISOString(),
          },
        });
        const { accountToken: _, recipientAccount: __, ...publicValue } = b;
        return json(
          {
            ...publicValue,
            detailsComplete: true,
            recipientMethod: input.method,
          },
          201,
        );
      }
      const detailsMatch = /^\/beneficiaries\/([a-zA-Z0-9_-]+)\/details$/.exec(
        path,
      );
      if (detailsMatch && request.method === "GET") {
        if (!options.recipientVault)
          throw new HttpError(503, "RECIPIENT_UNAVAILABLE");
        if (!["customer", "merchant_admin"].includes(account.role))
          throw new HttpError(403, "FORBIDDEN");
        const state = await auth.store.read(),
          b = state.beneficiaries.find(
            (b) =>
              b.id === detailsMatch[1] &&
              (account.role === "merchant_admin" ||
                b.customerId === account.customer_id),
          );
        if (!b?.recipientAccount) throw new HttpError(404, "NOT_FOUND");
        return json({
          country: b.country,
          currency: b.currency,
          method: b.recipientAccount.method,
          fields: options.recipientVault.open(b),
        });
      }
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
          await providerOrder(auth, account, id, options.recipientVault);
          if (request.method === "GET" && !action)
            return json(
              await providerOrder(auth, account, id, options.recipientVault),
            );
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
            else {
              const file = await body(3 * 1024 * 1024);
              if (options.scanner) await options.scanner.scan(file);
              else if (options.fundsMode === "live")
                throw new HttpError(503, "SCAN_UNAVAILABLE");
              await core.uploadReceiptFile(actorFor(account), id, file);
            }
            return json(
              await providerOrder(auth, account, id, options.recipientVault),
            );
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
      if (
        options.usdtOnly &&
        request.method === "POST" &&
        (/^\/(quotes|orders|batches|wallet\/deposits|partner)/.test(path) ||
          path.startsWith("/routes/USDC-"))
      ) {
        const input = await request.clone().json();
        const containsUsdc = (v: unknown): boolean =>
          (typeof v === "string" && /\bUSDC\b/.test(v)) ||
          (Array.isArray(v)
            ? v.some(containsUsdc)
            : !!v &&
              typeof v === "object" &&
              Object.values(v).some(containsUsdc));
        if (containsUsdc(input) || path.startsWith("/routes/USDC-"))
          throw new HttpError(400, "UNSUPPORTED_CURRENCY");
        if (path === "/orders" && typeof input.quoteId === "string") {
          const state = await auth.store.read();
          if (
            state.quotes.find((q) => q.id === input.quoteId)?.sourceCurrency ===
            "USDC"
          )
            throw new HttpError(400, "UNSUPPORTED_CURRENCY");
        }
      }
      if (
        options.usdtOnly &&
        request.method === "POST" &&
        /^\/batches\/[\w-]+\/(quote|submit)$/.test(path)
      ) {
        const batchId = path.split("/")[2],
          state = await auth.store.read();
        if (
          state.batchItems.some(
            (i) => i.batchId === batchId && i.sourceCurrency === "USDC",
          )
        )
          throw new HttpError(400, "UNSUPPORTED_CURRENCY");
      }
      let forwarded = request;
      if (
        options.fundsMode === "live" &&
        request.method === "POST" &&
        path === "/orders"
      ) {
        const orderInput = await body();
        if (orderInput.fundingSource !== "wallet")
          throw new HttpError(400, "WALLET_FUNDING_REQUIRED");
        forwarded = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(orderInput),
        });
      }

      if (path === "/receipts/upload" && request.method === "POST") {
        await auth.rate("receipt-scan:" + account.id, 10, 60000);
        const file = await body(3 * 1024 * 1024);
        if (options.scanner) await options.scanner.scan(file);
        else if (options.fundsMode === "live")
          throw new HttpError(503, "SCAN_UNAVAILABLE");
        forwarded = new Request(request.url, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(file),
        });
      }
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
      if (request.method === "GET" && path === "/routes") {
        const catalog = await routeCatalog(auth, account);
        return json(
          options.usdtOnly
            ? {
                ...catalog,
                routes: catalog.routes.filter((r) => r.sourceAsset === "USDT"),
              }
            : catalog,
        );
      }
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
      if (
        path === "/dashboard" &&
        request.method === "GET" &&
        account.role === "customer" &&
        options.funding &&
        result.ok
      ) {
        const data = await result.json();
        return json({
          ...data,
          storageMode: "postgres",
          storageLimits: null,
          fundingPayments: await options.funding.list(account),
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
