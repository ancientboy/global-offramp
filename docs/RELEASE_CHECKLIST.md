# Release checklist: single merchant administrator

Scope: update the existing mock product, GitHub repository and existing private Site. No new audience, credentials, live provider or real financial operations.

## Files and package hygiene

Publish source and documentation only. Preserve `.env.example` with placeholders, lockfiles, CI, reference SQL and runtime SQL. Exclude `.git`, `node_modules`, `.next`, `dist`, `sites-dist`, `out`, `coverage`, `qa`, screenshots, local manifests, upload/receipt directories, backups, database dumps, log files, archives and all `.env*` except `.env.example`. Do not include Site hosting credentials or `.openai` metadata in the GitHub package. The existing Site retains its own `.openai/hosting.json` locally and in its Sites artifact.

Build the package from a single reviewed source snapshot, not mixed worker checkouts. Hash each published file. For GitHub, compare against current main again immediately before updating the branch, preserve unrelated changes and use non-force updates. Large uploads should use bounded individual blobs and a SHA-only tree rather than one enormous request. Verify the resulting remote commit and CI for that exact SHA.

## Checks before publication

- TypeScript, core/API/web tests, reference SQL checks, API build
- Sites typecheck, Worker tests and bundle tests, static client build
- Browser happy path: target fiat quote, order funding screen, same administrator funding/confirmation, optional later attachment and customer download
- Negative paths: unauthorized customer/partner, duplicate confirmation, unknown lock and resolution, mismatched amount/time/reference, invalid/oversized receipt and state-cap rollback
- Private access remains unchanged; no real addresses, credentials, customer records or payment instructions in the package

## Site handoff

Copy reviewed source into the existing Site checkout's `integrated/` directory, excluding generated/runtime/private files. Preserve prototype fixture source, existing manifest and hosting identity. Root `npm run build` invokes the integrated build and prepares `dist/client`, `dist/server/index.js` and `dist/.openai/hosting.json`. Push the exact source state using the supported Sites flow; save/deploy only that state and preserve owner-private access. Inspect deployment status and run smoke checks against the actual published build.

## Acceptance boundaries

A passing mock release does not establish production login, custody, chain finality, banking, persistent files, antivirus, provider reconciliation, real refunds/commissions, database recovery, compliance or load capacity. Funding is nonpayable. Uploads are synthetic unscanned files in limited demo state. User acceptance should assess the simplified workflow, not readiness to receive funds.
