# Local mock operating and acceptance runbook

## Startup and health

1. Confirm no real customer data, wallet addresses, bank credentials or provider API keys are present.
2. Use explicit `EXECUTION_MODE=mock`, `DEMO_AUTH=true`, nonproduction API environment.
3. Run migrations, then API, then web; PostgreSQL/Redis for durable demo or MemoryStore for ephemeral tests.
4. Check GET `/api/health`: `mode=MOCK`, `realExecutionEnabled=false`. API health reports database connectivity only; worker/Redis readiness needs independent checks. Do not treat `status=ok` as financial or compliance readiness.
5. Run the end-to-end mock demo and reconcile journal sums per currency. Review outbox lag and unknown payout count.

## Unknown result / potential duplicate

Stop further provider actions. Do not create a new key or simply click “failed.” Preserve original attempt identity, exact amount and beneficiary, timestamps, provider reference and request evidence. Independently query the provider's authoritative record/statement. The merchant administrator can resolve to sent, or definitely failed only with evidence that no payment occurred. If inconclusive, keep unknown indefinitely and escalate. In the mock app, repeated or unresolved attempts remain blocked.

## Deposit mismatch

Do not treat a small/large/late amount as confirmed original-order funding. The ledger records it as unallocated custody liability and opens a case. Review depositor, chain/asset/network, finality, accepted-order funding expiry and ownership using provider records. Allocation and return require a separately reviewed workflow; the current mock intentionally cannot close these cases to “paid.” Never erase the original observation.

## Refund and commission

Reserve before recording a refund to prevent over-refunding. The merchant administrator confirms; legacy finance identities retain their separation rules. Record evidence and a unique reference once. Principal refund is only supported before conversion; a partial principal refund cancels the original order's payout, leaving remaining principal/fees explicitly outstanding. Complete residual-funds handling before production.

Service fee refunds reduce the frozen commission basis. A draft settlement whose contents changed is blocked. Cancel the unapproved draft with reason, then rebuild the same partner/month/currency. This releases old allocations and includes relevant negative adjustments; the merchant administrator confirms (legacy finance approval still requires another identity). Approved statements are historical and not deleted. There is no commission payment endpoint.

## Backup and restore (target local Docker environment)

The following commands are provided but were not executed because Docker is unavailable here. Use an authorized database and protect backups as private sensitive data.

```sh
mkdir -p private-backups
chmod 700 private-backups
docker compose exec -T postgres pg_dump -U offramp -d offramp -Fc > private-backups/offramp.dump
# Inspect backup before a restore; restoring overwrites a disposable target only.
pg_restore --list private-backups/offramp.dump
```

A production restore drill must target an isolated new database, verify all journal per-currency balances, compare row counts and business-key uniqueness, validate restored journal sealing, verify outbox watermark/consumer dedupe state, and reconcile with provider statements. Do not restore over a live financial system or replay financial actions automatically. Define RPO/RTO, encrypted backup storage, retention and restore ownership before launch.

## Required alerts / controls before production

- Webhook invalid signature spikes, deposit lag, unallocated custody amount and old cases
- Unknown payout age, concurrent attempts, provider-side duplicates and statement differences
- Ledger invariant failures, transaction rollback spikes, negative unexpected payable balances
- Outbox oldest pending age, relay errors, queue retention/storage, Redis downtime and failed jobs
- Auth/MFA/session anomalies, cross-customer access tests, object download failures and malware findings
- Database disk, replication, backup success and successful restore drill; reviewed break-glass access

## Security and privacy launch blockers

Replace demo auth with reviewed OIDC/session authentication, staff MFA, verified role membership and object-scoped authorization. Use a dedicated application DB role, separate migration owner, restrictive GRANTs and no application superuser. Configure encrypted transport, TLS ingress, CSRF protection if switching to cookies, rate limits, request-size controls, CSP, dependency updates, logging retention and PII redaction. Integrate private object storage, antivirus/content verification and short-lived owner-checked download URLs. No demo fixture may be promoted into a real customer record.

Never bypass fail-closed gates by changing an environment variable to claim auth/provider acceptance. Implement, independently review and test the integration first. Verify licensed/legal/compliance coverage with the actual providers and qualified professionals for the intended entity, customer, route and funds flow.

## Single-admin demo acceptance

Use only synthetic customer and attachment content. In the merchant workbench, confirm simulated funding, then register exact payout amount, payment timestamp, unique external reference and evidence. Confirming sent may precede receipt upload. Upload a PNG/JPEG/PDF sample no larger than 2 MiB and verify that its customer can download it, another customer cannot, and that upload does not mark bank verification or reconciliation. Unknown must remain locked until a documented resolution. The UI should never require switching maker/checker/finance to finish these steps.

Do not fund the displayed MOCK instruction: its address is intentionally null and payable is false. The 30-minute funding deadline does not guarantee the private hosted demo session survives that long. No real receipt or customer record belongs in this preview.
