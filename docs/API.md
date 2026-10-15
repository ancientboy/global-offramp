# API contract (MOCK only)

Prefix `/api`. Local development uses `x-demo-actor` selecting one server-side fixture: `customer-demo`, `company-demo`, `admin-demo` (merchant_admin), `maker-demo`, `checker-demo`, `checker-two-demo`, `auditor-demo`, `partner-demo`. Do not deploy this header authentication. No arbitrary actor/role headers are trusted. Production bootstrap fails closed.

All monetary inputs and outputs are JSON strings. Timestamps are ISO-8601 UTC. Most commands return the updated record; errors return `error` plus a safe message. Unknown input fields are rejected by strict schemas for financial DTOs.

| Method/path                         | Purpose                                      | Role / body                                                                           |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------- |
| GET `/health`                       | Liveness/dependency state, MOCK marker       | public, no financial data                                                             |
| GET `/dashboard`                    | Scoped view                                  | authenticated fixture                                                                 |
| GET `/audit`                        | Masked audit trail                           | finance/auditor                                                                       |
| POST `/customers`                   | Pending personal/company                     | operations: kind, name                                                                |
| POST `/customers/:id/review`        | Approve/suspend                              | finance: status                                                                       |
| POST `/beneficiaries`               | Create pending whitelist                     | customer/operations: customerId, name, country, currency, accountToken, accountMasked |
| POST `/beneficiaries/:id/approve`   | Independent review                           | finance                                                                               |
| POST `/quotes`                      | Immutable expiring quote                     | customer/operations: customerId, beneficiaryId, sourceCurrency, sourceAmount OR targetAmount, amountMode? |
| POST `/orders`                      | Accept quote                                 | quoteId, clientOrderId                                                                |
| POST `/orders/:id/conversion`       | Record external allocation                   | finance: providerReference, actualRate, evidence                                      |
| POST `/orders/:id/attempts`         | Reserve payout attempt                       | operations: idempotencyKey                                                            |
| POST `/attempts/:id/approve`        | Independent payout review                    | finance                                                                               |
| POST `/attempts/:id/record`         | Mock portal result                           | designated maker: outcome sent/unknown, providerReference if sent, evidence           |
| POST `/attempts/:id/resolve`        | Independently resolve unknown                | finance: outcome sent/failed, providerReference if sent, evidence                     |
| POST `/orders/:id/receipt-metadata` | Mock private receipt reference               | operations/finance: objectKey                                                         |
| POST `/orders/:id/reconcile`        | Verify provider reference/amount             | finance: providerReference, actualAmount, evidence                                    |
| POST `/discrepancies/:id/resolve`   | Evidence-based resolution                    | finance: evidence; unallocated deposits remain blocked                                |
| POST `/orders/:id/refunds`          | Reserve partial principal/fee refund         | operations: idempotencyKey, kind principal/service_fee, amount                        |
| POST `/refunds/:id/approve`         | Independent approval                         | finance                                                                               |
| POST `/refunds/:id/record`          | Record mock external refund                  | designated maker: providerReference, evidence                                         |
| POST `/settlements`                 | Closed-month eligible commission draft       | finance: partnerId, month YYYY-MM, currency USDT/USDC                                 |
| POST `/settlements/:id/approve`     | Independent statement approval               | different finance identity                                                            |
| POST `/settlements/:id/cancel`      | Cancel unapproved draft, release allocations | finance: reason; rebuild using POST /settlements                                      |
| POST `/batches`                     | Validate rows independently                  | customer/operations: customerId, clientBatchId, csv                                   |
| POST `/batches/:id/submit`          | Create orders for valid items once           | same customer scope                                                                   |
| POST `/webhooks/mock-deposit`       | Signed mock deposit                          | public route, cryptographic signature required                                        |

Webhook headers: `x-webhook-timestamp` (Unix seconds), `x-webhook-signature` (hex HMAC-SHA256 of `${timestamp}.${rawBody}`). Secret is server-configured and never returned. Body:

```json
{
  "eventId": "mock-event-1",
  "transactionId": "mock-tx-1",
  "orderId": "GENERATED_ORDER_ID",
  "currency": "USDT",
  "amount": "1007.000000",
  "network": "MOCK",
  "confirmations": 1
}
```

Only `MOCK` network is accepted. Event identity and transaction identity dedupe independently; changing economic payload for an existing transaction conflicts. Real confirmations, reorganizations, address allocation and polling ingestion require vendor-specific implementation. `MockCustodyProvider.poll` is an empty contract stub, not a live watcher.

CSV columns: `clientItemId,beneficiaryId,sourceCurrency,sourceAmount`. Up to 100 data rows and 100KB. Client item IDs are unique across the customer's batches. Import returns per-item `valid` or `error`; submit promotes valid records to `created` once. Invalid rows are not paid or ordered. Batch status is derived from children; no atomic “all successful” claim is made.

Payout `sent` means recorded portal success pending recorded reconciliation, not final proof. Customer receipt file state is separate. Commission eligibility derives from reconciled sent orders (single-admin attestation is labelled as such); an uploaded receipt by itself never creates commission.

## Unified frontend demonstration endpoints

`POST /api/demo/scenario`, body `{"idempotencyKey":"workspace-default-v1"}`, is restricted to the operations mock actor and explicit mock/nonproduction runtime. It creates three linked orders through the same domain commands: confirmed CNY deposit, approved USD payout, and independently reconciled CNY payout with a held commission. Repeated calls with the same key return the same server fixture IDs. The operation is visibly marked fixture-only and does not model independently authenticated real people.

`POST /api/demo/orders/:id/deposit` with `{}` is operations-only. It signs an exact MOCK deposit event internally and runs the normal webhook processing path. The browser never receives the signing secret. Customer and partner actors are rejected.

Dashboard additions: customers see only their batches/items; operations/finance/auditors see operational batches/items and a read-only `pricingFixture`. Finance/auditors also see commission and settlement records. Partners receive safe commissions with server-derived `eligibility` (`hold`, `available`, `allocated`, `frozen`) and no order principal, customer identity, account information or cost rates. The persisted commission state is not a claim that funds are withdrawable.

## Explicit amount input mode

`POST /quotes` accepts `amountMode: "principal" | "total_deposit"`. Omission retains the original API default `principal`; the UI explicitly defaults to `total_deposit`. The input field `sourceAmount` means the entered amount in the selected mode. Frozen responses include `amountMode`, `inputAmount`, effective principal `sourceAmount`, `serviceFee`, `channelFee`, `totalDeposit` and `payoutAmount`, all as exact decimal strings. In total mode fees are deducted before conversion, and a total consumed by fees is rejected. Example: total 1000 = principal 993 + service 5 + channel 2; 993 × 7.2 = 7149.60 CNY. CSV remains explicitly principal mode.

## Hosted private mock adapter

The hosted adapter shares domain logic but owns a separate ephemeral per-cookie MemoryStore. It does not expose external webhook routes. GET health is stateless; GET dashboard alone can create a synthetic session. Subsequent commands require that cookie, a fixed fixture actor and a matching Origin. Expiry returns SESSION_EXPIRED rather than silently replaying a command into a new session. See sites/README.md for reset and limits.

## Current single-administrator contract (2026-10-15)

`admin-demo` selects the server-owned `merchant_admin` fixture. It can complete the operational workflow without identity switching. Legacy maker/checker routes above remain for compatibility and their original role separation still applies to those legacy roles; the merchant administrator has explicit permissions for its unified flow. This is not production authentication.

- POST `/orders/:id/manual-payout`: administrator only. Body `{idempotencyKey, outcome: "sent" | "unknown", actualAmount?, paidAt?, providerReference?, evidence}`. Sent requires exact order fiat amount, ISO timestamp after order creation (at most 60 seconds future tolerance), and unique reference. Confirmed deposit, approved customer/beneficiary and no open discrepancy/principal refund are required. It records external allocation as an administrator attestation if pending; it never performs an exchange or payment. Changed payload on reused key conflicts. Sent or unresolved unknown blocks another payout.
- POST `/orders/:id/receipt-file`: `{fileName, contentType, dataBase64}`. Only after sent. PNG/JPEG/PDF, at most 2,097,152 decoded bytes; canonical base64, extension and magic-byte matching required. Replacement is audited. Upload is optional and does not reconcile or bank-verify payment.
- GET `/orders/:id/receipt-file`: returns mock file metadata/base64 for authorized order readers, not a public URL. Customer ownership is enforced; normal order/dashboard projections omit file bytes. `scanStatus: not_scanned` is intentional. Synthetic attachments only.
- POST `/quotes` with `amountMode: "target_payout"` requires `targetAmount`, accepts an optional matching `payoutCurrency` (CNY/USD), and forbids `sourceAmount`. Other modes require sourceAmount and forbid targetAmount. Target currency comes from the selected approved beneficiary. Reverse calculation rounds stablecoin principal up, then validates forward payout exactly; fees remain separate. The snapshot includes requested target and input currency.
- New orders contain `fundingExpiresAt` (30 minutes after creation) and `fundingInstruction`: mock, nonpayable, status mock_nonpayable, reference, network MOCK, address null, currency, amount, expiresAt. Quote expiry gates acceptance, not the already accepted order's funding deadline. No live funding provider or blockchain ingestion is implemented.

Single-admin payment/reconciliation records are `admin_attestation`, not independent bank verification. Commission eligibility still requires reconciliation; uploading a receipt alone is insufficient. On Sites all attachments and business state are volatile session memory, with a maximum 30-minute session lifetime and possible earlier loss.

Unknown-to-sent resolution through `/attempts/:id/resolve` also requires exact actualAmount and paidAt. Receipt metadata cannot replace an already uploaded file. Sites limits: 3 MiB JSON body, 4 MiB state per session, at most 4 volatile sessions per isolate.
