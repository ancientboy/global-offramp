# Private MOCK Sites adapter

This adapter serves the exact `packages/core` OfframpService, MemoryStore,
fixture actors, fixed-point money, ledger and authorization logic through a
Cloudflare-compatible `fetch(request, env)` ES module. It serves the exported
Next client through `env.ASSETS` on all non-API paths. It is **not** the NestJS
server or a deployed PostgreSQL backend. It has no provider integrations,
real-money execution, raw TCP, object/file upload storage, queue consumer,
persistent database, identity provider, or durable ledger.

Publish only inside the existing private Site. Site access control is supplied
by the host and is separate from fixture roles. The `x-demo-actor` header selects
server-defined simulation actors; it is **not real user authentication**. Do not
change Site access or existing project identities as part of the build. The
publisher supplies the existing Site manifest and asset binding.

Use synthetic data only. The UI must visibly warn not to enter real customer,
account, payment, receipt or other private information. No assertion that the
preview has real identity authentication or persistent private storage is valid.

## Build and check

From this repository root (works unchanged after copying the whole project):

```sh
npm ci
npx tsc -p sites/tsconfig.json
node --import tsx --test sites/*.test.ts
SITE_EXPORT=true npx next build apps/web
node scripts/build-sites.mjs
```

The last step copies `apps/web/out` to `sites-dist/client` and emits the bundled
Worker at `sites-dist/server/index.js`. It fails if the export is absent. It does
not touch the Node API's `dist/` or any `.openai` files. For server-only local
checks, use `node scripts/build-sites.mjs --worker-only`.

Dependencies used by the bundler are `esbuild`, `@noble/hashes`, and `buffer`, plus
existing `zod` and `csv-parse`. The build aliases `node:crypto` to the narrow local
SHA256/HMAC/UUID shim and `csv-parse/sync` to `csv-parse/browser/esm/sync`, and
injects a Buffer export. It produces one ES module with only a default fetch
handler export and no unresolved Node imports. No `nodejs_compat` flag is needed
or assumed. The SHA256 and HMAC output is verified against native Node crypto.
The equal-length byte comparison visits every byte without early exit; a JS
runtime cannot promise native constant-time execution. No external request can
submit a signed deposit webhook in this adapter.

## Session behavior and bounds

- `GET /api/health` is stateless and never sets a cookie. It reports `mode: MOCK`,
  `realExecutionEnabled: false`, `persistence: session-memory`, `volatile: true`,
  `ttlSeconds: 1800` and the per-isolate memory limitation.
- Only `GET /api/dashboard` can create a session. Parallel health/dashboard first
  loads therefore cannot race to replace the browser cookie. Separate concurrent
  dashboard calls without a cookie can create separate empty sessions; clients
  should use one dashboard bootstrap request, then retain its cookie.
- The cookie is 256 random bits, `__Host-offramp-preview`, `Path=/`, `HttpOnly`,
  `Secure`, `SameSite=Strict`, with a fixed 30-minute lifetime. The signing secret
  is separately generated per session, stored server-side, and never exposed.
- Same-cookie requests keep state only within the same live Worker isolate.
  Browser sessions are isolated, not a globally shared business store. Expiry,
  capacity eviction, instance replacement, deployment or another isolate can
  lose the state. There is no durability or cross-isolate affinity guarantee.
- Every write requires an existing live cookie, exact same-origin `Origin`, and
  `Sec-Fetch-Site: same-origin` when that header is present. A missing/expired
  write session returns HTTP 410 `SESSION_EXPIRED`, without replay or implicit
  creation. The user must explicitly reload/bootstrap a fresh dashboard.
- At most 16 sessions per isolate, with at most 1 MiB JSON domain state per
  session. Core transactions that exceed the cap roll back. Only idle synthetic
  sessions can be evicted. Queued or active commands are never evicted.
- Per session: 120 requests/minute, 40 commands/minute, 8 pending requests.
  Per isolate: 600 API requests/minute and 32 new sessions/minute. HTTP 429 has
  a `Retry-After: 60` header. Expired sessions are cleaned on API access.
- JSON bodies are capped at 128 KiB (including streamed bodies), with a 5-second
  body-read deadline. Domain CSV limits remain enforced by the core. Commands
  are serialized across the entire session; the scenario endpoint is idempotent
  across simultaneous repeated commands.
- JSON is private/no-store. Unexpected exceptions become generic errors; no
  stack, provider error, signing secret or body is echoed. Domain rule failures
  retain authored domain error codes and safe explanations.

## API

The Worker explicitly allowlists the read and command routes from
`apps/api/src/app.ts`. All domain changes use core public methods. There is no
method-name dispatch and no `/api/webhooks/mock-deposit` route. Normal Node
runtime checks and `apps/api/src/demo.ts` are unchanged; the Worker never spoofs
`NODE_ENV` or a process environment.

`POST /api/demo/scenario` accepts `{ "idempotencyKey": "sample-key" }` for
`maker-demo` only. It creates three bounded synthetic fixtures: funded,
approved, reconciled. The same key reuses the same logical three orders. Partial
progress is recoverable by the same key. Its internal role transitions use the
known server fixture maker/checker actors; arbitrary role elevation is not
accepted from request data. Quotes explicitly use principal amount mode here;
regular quote commands pass the requested principal/total-deposit mode unchanged
through the core calculation.

`POST /api/demo/orders/:id/deposit` accepts an empty JSON object and requires
`maker-demo`. It constructs an exact MOCK-network event from the stored order,
signs it with the per-session secret, and calls the core webhook validator. No
request field can supply amount, destination, network, signing secret, or role.
Repeated deposit calls retain core event/transaction idempotence.

`POST /api/demo/reset` is an adapter-only disposal action. It requires
`maker-demo`, the live session cookie, same-origin headers, and exactly
`{ "confirm": "reset-synthetic-session" }`. Invoke only from an explicit reset
button/authorized smoke-test action. It discards only that session's synthetic
state and rotates its internal signing secret. It does not extend the lifetime
or reset rate counters; other sessions are untouched.

## Test coverage

The checks exercise isolation, persistence, fixture-role visibility, unknown
actors, origin rejection, stateless initial health, expired writes, fixed TTL,
LRU cap, transactional size rollback, bounded rates, explicit reset, request
size, route allowlisting, idempotent/concurrent scenarios, unknown-payout retry
blocking, exact fixed-point quote math, and asset delegation. Production-bundle
tests execute the emitted module through dashboard, scenario, partner SHA256 and
CSV paths. Crypto tests compare SHA256/HMAC to native Node, including browser
bundling with no Node globals.
