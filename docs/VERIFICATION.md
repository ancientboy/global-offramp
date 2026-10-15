# Verification record

The baseline section below is historical (2026-10-13). It is not proof that the 2026-10-15 single-admin changes passed. Current-release results must be appended after final testing/review; neither baseline nor new mock tests certify production readiness.

## Historical passed checks (2026-10-13)

- Node.js 24.19.0 / npm 11.9.0 install with lockfile
- `npm run typecheck`: backend/domain/scripts strict TypeScript check
- `npm test`: **41 passing tests**, zero failed or skipped
  - domain money/state/authorization/idempotency/refund/commission/settlement/batch checks, plus explicit total-payment/principal quote modes
  - linked mock-scenario API guards and idempotence
  - frontend exact-decimal formatting, CSV escaping, server-status projections and hosted-session reset visibility
  - actual NestJS HTTP server test for demo auth, customer scope, numeric-input rejection and signed deposit
  - actual runtime SQL in PGlite: atomic aggregate/ledger/audit/outbox commit, SQL rollback, per-currency balance, precision, immutable/sealed journals, exact reversals
- `npm run test:db`: **63 SQL invariant checks**, plus committed journal sealing and exact-decimal reads, against the separate normalized reference schema
- `npm run build`: optimized Next.js 16.4.0 build, frontend TypeScript and prerendering
- `npm run build:api`: compiled backend/outbox-worker output
- `npm run typecheck:sites` and `npm run test:sites`: **32 passing tests** for per-session isolation, expiry, reset, strict origin, bounds, error sanitization, idempotent scenarios, SHA256/HMAC parity and execution of the actual standalone Worker bundle
- `npm run build:sites`: optimized static Next.js export plus standalone browser-compatible Worker, no unresolved Node imports
- `npm run format:check`: source format checks
- `npm run demo`: full HTTP flow against a running local NestJS API: quote → order → HMAC deposit → external conversion record → maker/checker → sent → independent reconciliation → 1.000000 USDT commission fixture
- Running Next.js HTML smoke check: the workbench rendered, and `/api/health` successfully proxied to the live local mock API
- `npm audit --omit=dev`: zero reported runtime dependency vulnerabilities at check time, after upgrading csv-parse to 7.0.3. This is an advisory check, not a security audit.

## Browser interaction check

Using the supported cloud Chrome against an isolated local Next.js → NestJS mock preview, the following were actually exercised:

- Default total-payment 1000 USDT → fees 5 + 2 → principal 993 → payout 7149.60 CNY; customer confirmation created a server order.
- Operations signed exact mock deposit; finance recorded external conversion; maker submitted and separate checker approved.
- Unknown-result registration hid retry controls; finance independently resolved sent and reconciled provider record.
- Partner view showed only its 1 USDT commission on 5 USDT service fee, with seven-day hold. Company fixture could not see personal customer orders.
- Server validation saved a CSV with two valid and one invalid beneficiary row; reopening the saved batch survived frontend state reset. Submission created exactly two orders and left the invalid line rejected.
- Desktop screenshot review passed; at a compact 932 CSS-pixel viewport the page had no document-level horizontal overflow. This is not mobile-device certification.

The integrated artifact was also published behind the unchanged owner-only private Site gate. Seven actual hosted API smoke checks passed: health MOCK/session-memory/volatile/TTL1800; exact total-payment quote; order creation and own-session visibility; second-session isolation; invalid actor rejection (401); reset clears only the current session; the other session survives reset. Both synthetic smoke sessions were cleaned. This establishes one hosted-isolate request flow, not durable or cross-isolate persistence.

## Not established

- Docker image or Docker Compose startup: Docker is unavailable in this executor
- Native/networked PostgreSQL, multiple simultaneous database sessions, failover, migration/restore drills and real role privileges
- Redis/BullMQ runtime connectivity, retry/failure injection and delivery under real process crashes
- Full browser/device matrix and formal visual acceptance; mobile browser interaction for the newly integrated client has not been verified
- Real identity/MFA, KYC/KYB, custody, chain confirmations/reorgs, conversion, fiat provider, refunds, statement polling or commission payments
- Private object upload/download, malware scan and content/ownership verification
- Load, penetration, operational, financial and legal/compliance acceptance

## Independent review findings repaired

The review found and reproduced: changed economics on reused journal keys, invalid reversal account/amount acceptance, a shared SQL trigger field error, later insertion into committed journals, sub-cent fiat entries, webhook transaction payload changes, split-refund rounding dust, cross-batch duplicate items, customer-facing attribution metadata, and stale settlement draft approval. These cases were fixed and covered with regression tests. Settlement cancellation/rebuild was subsequently added with an audit and regression test.

The app's runtime adapter and the normalized reference design remain explicitly separate. Tests on one are not evidence that the other has been wired into the API. Read ARCHITECTURE.md before extending persistence.

## 2026-10-15 single-admin revision

Independent review reported 53 core/API/web tests, 34 Sites tests, 63 reference SQL assertions, backend TypeScript and Sites TypeScript passing against the revised source. Coverage includes single-admin operation, target-fiat quote math, separate funding expiry, unknown-result protection, duplicate confirmation, receipt authorization and bounded mock file storage. Publication/build verification and hosted browser acceptance are separate release gates; they are not established by these unit/API checks alone.
