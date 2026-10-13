# PostgreSQL persistence contract

This directory contains the normalized **target schema** for the mock offramp MVP, plus executable database invariant tests. The API demo uses its separate `runtime` aggregate persistence adapter. Applying this migration does **not** connect the API to these tables, contact a payout provider, deploy an application, or move funds. Mapping the application commands into this normalized schema is a remaining production-integration task.

## Run the checks

From the repository root:

```sh
npm run test:db
# Equivalent:
node scripts/db-test.mjs
```

The runner creates an in-memory PostgreSQL instance with `@electric-sql/pglite`, applies the actual migration, exercises the SQL checks, and closes it. It has no database URL and cannot connect to an external database. PGlite runs PostgreSQL semantics rather than mocking SQL. The fixture checks roll back; a separate disposable committed-transaction test verifies that ledger journals are sealed after commit.

With an explicitly selected **disposable local** PostgreSQL 15+ database and `psql` installed:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_core.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/tests/invariants.sql
```

The migration applies once, transactionally, and creates only the `offramp` schema. It does not create roles or extensions. The SQL regression script uses a single transaction and rolls back all fixtures. The migration is intentionally not rerunnable and has no destructive down migration.

### Verification boundaries

- The embedded runner verifies parsing, trigger execution, constraint timing, and actual decimal arithmetic.
- It does **not** verify networked PostgreSQL drivers, connection pools, two-session races, failover, backups, read replicas, provider authenticity, webhook signature cryptography, or production privileges.
- Run multi-connection tests on full PostgreSQL before real integration. The schema has order-row locks and unique indexes for critical races, but those are not equivalent to having executed concurrency/load tests.
- Both database-owner and superuser access can bypass or disable ordinary SQL protections. Use an application role without ownership, DDL, trigger-disabling privileges, or direct administrative access in a deployed system.

## Conventions

- Tables live in `offramp`; UUID keys default to native `gen_random_uuid()`.
- Monetary values use `exact_amount`, a finite `NUMERIC(38,18)` domain. Never pass JavaScript `number` values, parse decimals as binary floats, or serialize money as JSON numbers. Use decimal strings / integer atomic-unit conversions.
- PostgreSQL rounds inputs to a declared numeric scale before a table check can inspect them. The API must reject more than 18 fractional digits **before** binding SQL, and apply the explicit currency rounding policy before constructing a quote. Do not treat database scale as input validation.
- `currencies.minor_units` controls allowed ledger precision. CNY and USD are seeded with 2 minor units for the mainland China CNY and United States USD routes; USDT and USDC have 6. The reference registry may include non-enabled accounting currencies: EUR remains only for cross-currency invariant tests. Presence in this registry does **not** mean a payout route is available; route availability is separately controlled by the application and provider configuration. Supporting a chain/token with a different native precision requires a proper asset/network registry and adapter mapping, not blindly reusing a symbol.
- Positive ledger entry amounts are debits; negative amounts are credits. Liability balances are normally negative. Reports must use account kind when presenting economic balances.
- Times are `timestamptz`; settlement periods are UTC calendar months represented by their first date.
- `*_ref` fields contain mock or vault references. There are no credential, signing-key, full bank-account, or card fields. Do not put secrets or unredacted personal data in JSON, logs, audit records, or outbox payloads.

## Table and command mapping

| Area | Tables / contract |
| --- | --- |
| Simple accounts | `customers`: `personal` or `company`, a verified status, and one external identity; complex organization membership is outside the MVP |
| Staff identities | `actors`: separate maker/checker identifiers; approval checkers must be enabled human actors |
| Beneficiary whitelist | `beneficiaries`: versioned immutable destination details, explicit active approval, customer/currency matching |
| Immutable pricing | `quotes`: versioned JSON snapshot plus normalized input amount, rate, gross payout, fee, net payout, spread revenue, currencies and expiry |
| Orders | `orders`: immutable financial terms and beneficiary snapshot; independent `deposit_state`, `payout_state`, and `receipt_state`; unique customer/client order ID and quote consumption |
| Partner attribution | `order_attributions` and `commission_rule_versions`: immutable partner/rule mapping and version snapshots |
| Incoming funds | `deposit_transfers`: immutable ownership of a unique network/transaction/output; `deposit_observations`: append-only confirmation observations that cannot change that ownership or amount |
| Payout requests | `payout_attempts`: one ordered sequence, immutable amount/payee, unique idempotency key, immutable provider ID, maker/checker, definitive-failure evidence |
| Refund requests | `refunds`: one full-deposit refund per order, unique idempotency key, separate maker/checker, immutable return destination |
| Accounting | `ledger_accounts`, `ledger_journals`, `ledger_entries`, `ledger_balances` |
| Partner earnings | `commission_events`: positive accruals and separate negative adjustments, immutable rule snapshots, required matching partner-liability ledger movements |
| Monthly settlement | `monthly_settlements`, `settlement_allocations`: unique partner/currency/month; each commission event can be allocated once, including adjustments |
| Bulk operations | `batches`, `batch_items`: customer-scoped client batch IDs; client item IDs unique across that customer's batches to prevent repeat-upload duplication |
| Provider ingress | `webhook_events`: unique provider/event ID, immutable payload/hash; processing status is separate |
| Reliable egress | `outbox_events`: immutable versioned payload, dedupe key, lease state, attempts and delivery metadata |
| Operational exceptions | `reconciliation_cases`: deduplicated cases with evidence, ownership and explicit resolution |
| Audit | `audit_events`: append-only actor, action, entity, request and before/after metadata |

### Quote and beneficiary snapshots

Quote JSON must contain a `version` matching the normalized version, and these matching **string** values: `inputAmount`, `rate`, `grossOutputAmount`, `feeAmount`, `netOutputAmount`. Additional quote policy/FX source/expiry metadata can be retained in the JSON. The normalized columns are used for accounting; the preserved snapshot supports explanation and audit. `net_output_amount = gross_output_amount - fee_amount` is enforced.

Commission rule snapshots must contain matching `version`, `basis`, and decimal-string `rate`. Retain the full business rule and other policy fields as additional keys. Events copy the whole stored rule snapshot, not a fresh version of the rule.

Build the beneficiary snapshot with:

```sql
SELECT offramp.make_beneficiary_snapshot(b)
FROM offramp.beneficiaries b
WHERE b.id = $1;
```

Order insertion requires that exact approved version's snapshot. An existing order retains the original snapshot if a later whitelist version is added. A blocked beneficiary or unverified customer prevents new payout approval/submission.

### Payout state and retry contract

Each attempt starts at `awaiting_approval`. Allowed transitions are:

```text
awaiting_approval -> approved | cancelled
approved         -> submitting | cancelled
submitting       -> processing | unknown | succeeded | failed
processing       -> unknown | succeeded | failed
unknown          -> processing | succeeded | failed
```

`failed` requires `definitive_failure = true` and evidence. An `unknown` result also requires nonempty reconciliation evidence before it changes state. Timeout, dropped response, or provider unavailability **must not** be classified as definitive failure. `succeeded`, `failed`, and `cancelled` are terminal for that attempt.

Only failed or pre-submission-cancelled attempts permit another attempt. The unique live/successful-attempt index independently blocks duplicate active payouts, and a trigger locks the order to serialize payout and refund reservations. A successful payout permanently blocks another payout. Resubmitting the same provider request uses the **same** original provider idempotency key and must not create another local attempt.

A refund is the whole observed original-currency deposit in this MVP. Payout activity that is pending, uncertain, processing, or successful blocks it. A reserved refund blocks payout. Failed refunds require explicit reconciliation; this schema intentionally does not expose a generic new-refund-key retry or partial-refund allocation primitive.

Service code must authenticate actors from trusted identity context, enforce role/scope authorization, validate provider evidence, verify confirmed deposits, and update the denormalized order states alongside attempt changes in the same transaction. SQL does not establish that an externally supplied actor ID, signature flag, evidence JSON, or deposit observation is genuine. Do not expose unrestricted table writes as a public API.

### Double-entry accounting

1. Start one SQL transaction.
2. Insert a journal with a deterministic unique `idempotency_key`.
3. Insert all its entries, with debit positive and credit negative.
4. Insert related business changes, outbox events and audit records.
5. Commit.

Deferred constraint triggers reject empty/single-entry journals and any nonzero sum **within each currency**. USD +100 and EUR -100 never balance. Use clearing accounts on both currency sides for conversion. Currency/account mismatch and excess currency fractional precision also fail.

Journals and entries cannot be updated, deleted, or truncated. The server stamps the journal's creating transaction ID; entries may only be inserted in that same transaction. A later transaction cannot append even balanced lines to a committed journal.

To reverse a journal, create a new `reversal` journal referencing `reverses_journal_id`. Its aggregate entries must exactly negate the original per account and currency. An original can be reversed only once. Partial business corrections use separate ordinary correction/adjustment journals; they cannot masquerade as a full reversal.

The general ledger checks balance and reversal accuracy. The service is still responsible for selecting the correct accounts, linking one economic event to one deterministic journal key, and ensuring provider settlement has actually occurred. In particular, it must not accrue commission merely because an order was created.

### Commission and monthly settlement

A positive accrual references the immutable order attribution and rule version. A negative adjustment references its original accrual and must use the same order, partner, currency and rule. Cumulative negative adjustments cannot exceed that original accrual. Each event requires a unique balanced journal whose matching partner liability changes by the inverse of the signed commission amount.

Settlement allocations are append-only and unique per commission event. Add eligible current/earlier-period events while the settlement is `draft`, and set `total_amount` to their exact signed sum in the **same transaction**. Negative adjustments reduce the total; a net-negative balance must be carried into a later nonnegative settlement rather than submitted as a negative payment. Approving seals the amount and allocation set. Paying requires a settlement journal that reduces that partner's liability by the total. Correction of an already paid commission creates a new negative event for a later settlement; it does not rewrite the paid statement.

### Webhooks, outbox and batches

Verify provider signatures and parse events before inserting them. `webhook_events` deduplicates by `(provider, external_event_id)`. On conflict, compare the hash: identical content can be acknowledged; changed content under the same identity should be quarantined and investigated. The schema retains a boolean assertion that verification happened; it does not perform cryptography. Never let a duplicate event credit a deposit twice: keep one canonical `deposit_transfers` owner and a deterministic deposit journal key.

Insert outbox rows **inside the same transaction** as the state/ledger/audit changes. The schema does not synthesize messages automatically. An application that inserts an outbox row after committing business data is still unsafe. Delivery is at-least-once: consumers must deduplicate by the outbox event identity/key. Lease due work with `FOR UPDATE SKIP LOCKED`; recover expired leases, use bounded backoff, and preserve the original business payload on every retry.

A minimal claim transaction can use:

```sql
WITH next_event AS (
  SELECT id FROM offramp.outbox_events
  WHERE (state = 'pending' AND available_at <= now())
     OR (state = 'leased' AND lease_until < now())
  ORDER BY available_at, created_at
  FOR UPDATE SKIP LOCKED LIMIT 1
)
UPDATE offramp.outbox_events e
SET state = 'leased', lease_owner = $1,
    lease_until = now() + interval '30 seconds', attempts = attempts + 1
FROM next_event n WHERE e.id = n.id
RETURNING e.*;
```

On delivery, clear both lease fields and set `delivered_at`. On an idempotent batch retry, compare request hashes rather than silently treating changed content as the same request. Validate/create items individually; one rejected row should not undo successful independent batch items.

## Before any production use

This is a source-level mock MVP. Real deployment additionally requires a normalized command/repository adapter, full PostgreSQL multi-session tests, least-privilege grants and authenticated role enforcement, provider signature/query integration, network-specific finality and reorg handling, secure custody and destination verification, screening/compliance controls, operational reconciliation, and independently reviewed payout/refund/settlement execution. None is implied by a green embedded SQL test run.
