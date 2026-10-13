# Architecture decisions and limits

## Source of truth

For the local NestJS PostgreSQL configuration, PostgreSQL is the durable source. Redis is never a money store. The runnable mock adapter locks one `runtime.state` row, evaluates the command against a clone, checks immutable historical records, inserts all new ledger journals, ledger lines, masked audits and outbox events, then updates the business aggregate and commits once. A SQL constraint failure rolls back every projection and the aggregate.

The volatile `MemoryStore` has the same command contract and serialized writes, for tests and local demos only. Returned objects are cloned to prevent callers mutating stored financial snapshots.

## Deliberate mock compromise

Business aggregates are currently serialized JSONB rather than fully normalized entities. This gives a small, inspectable correctness model but creates a global write bottleneck, duplicates historical data inside the document, and is unsuitable for substantial data volume or real financial operation. It has no per-tenant row-level security, authenticated actor database roles, archival partition strategy, schema migration history or data repair tooling.

`db/migrations/001_core.sql` is an independently tested relational reference. Its refund and quote models deliberately are not claimed as interchangeable with the runtime model. Before integration, reconcile these contracts, implement repositories/UoWs on normalized tables, migrate fixture/data shapes, and rerun end-to-end tests. The current app migration command applies only `db-runtime.sql`.

The runtime ledger is already relational with NUMERIC(38,18), per-currency precision checks, deferrable journal balance, append-only DML guards, transaction-bound sealing and exact reversal checks. The application only sends currency-valid decimal strings. PostgreSQL owner/superuser privileges can still bypass these safeguards, so production must use least-privilege roles and reviewed posting functions. Transaction IDs used for sealing must be treated carefully in restore/migration planning; restored ledger data is historical and the application must never receive direct insert rights on prior journals.

## Financial model

- Quotes freeze the explicit input mode. Principal mode adds service/channel fees; total-deposit mode deducts those fees to derive principal. Both preserve the same principal + fees = total identity in source stablecoin. Payout is the principal multiplied by customer rate, rounded down to fiat minor units.
- Deposit debits custody assets and credits an order liability. Mismatched/late/extra deposits credit a separate unallocated liability and cannot fund the order automatically.
- Recorded external conversion debits source order principal liability and credits custody; separately debits target provider assets and credits order payout liability. This is an allocation model. It does not claim to calculate real treasury spread, slippage, inventory cost or provider costs.
- Sent payout debits payout liability and credits provider assets. Only then is service revenue realized; channel fees remain a separate payable.
- Commissions debit partner expense and credit partner payable. Principal, channel fees and FX spread are not commission bases. Independent reconciliation and the quote’s frozen attribution/rule are required.
- Refunds reverse the proper liability/revenue and custody leg. Service refunds reduce commissions to the cumulative net basis, so split refunds cannot leave rounding dust. Pre-accrual refunds reduce the initial base; later refunds produce separate negative entries.
- A principal refund before conversion cancels the original payout. Partial remaining funds and unused fees are still liabilities; this MVP does not silently clear them or provide a completed full-order refund orchestration. They need the reviewed residual-funds workflow before production.

## Manual execution boundary

The app cannot log into a provider, broadcast a token transfer, call a money API or submit a bank payment. Operators record mock external actions. Maker and checker are separate server-side fixture identities in development, not evidence of real authentication. A production manual portal process must claim/reserve the execution task before portal submission, persist an in-progress/unknown state before the external side effect, and have independent statement verification. Implement and test that provider-specific SOP before enabling any real operation.

An unknown attempt blocks new attempts. Only independent finance verification can mark it sent or definitely failed. A definitely failed attempt permits a new attempt. Retries must use stable provider-side idempotency and immutable destination snapshots when real providers are integrated.

## Outbox

Events and monetary changes commit together. A PostgreSQL row-locked relay adds BullMQ jobs with stable event IDs and marks them delivered. If the process dies after enqueuing but before committing, retry uses the same job ID. Consumers record an immutable event ID in PostgreSQL, making their mock effect idempotent. Processing is at least once, not a claim of exactly-once external side effects. Jobs currently only record internal mock delivery; notification destinations, retention and provider actions are intentionally unconfigured.

## Files and authentication

Private file upload/download/verification and token verification are interfaces with fail-closed unconfigured implementations. No public bucket or permanent file URL exists. The UI records no uploaded bytes; receipt metadata is a simulation only. Real integration must verify ownership, object existence, content hash, MIME/magic bytes, size and clean scan status before attaching the receipt.

Customer and partner views project safe fields; finance/auditor scopes see operational evidence metadata. Raw request bodies must never be logged. Credential, webhook and account secrets must never enter audit, jobs or Library artifacts.

## Private hosted session preview

The Sites artifact is deliberately a separate hosting adapter, not a deployment of NestJS/PostgreSQL. Static Next.js calls a browser-compatible Worker bundle reusing the same OfframpService with one MemoryStore per opaque cookie. There is no shared customer dataset or persistent financial storage. TTL/capacity/instance loss may erase a session; requests after loss fail explicitly and the UI never automatically replays money-like commands. Fixed actors, synthetic fixtures and no live-provider/webhook route keep this an isolated demonstration. The original production fail-closed authentication policy is unchanged. Full adapter limits and acceptance tests are documented in sites/README.md.
