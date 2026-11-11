# Global off-ramp route catalogue (draft-only)

This isolated TypeScript module defines the first requested catalogue for **CNY, USD, EUR, MXN, BRL, GBP** payouts funded from **USDT or USDC**. It is reusable by a frontend form and a backend validator, and is integrated into `/workspace/api/routes`, server-side recipient format validation, and the workspace route configuration panel. Draft settings are stored in PostgreSQL and never activate funds. The existing sandbox quote/order engine still supports CNY and USD; this catalogue does not claim EUR/MXN/BRL/GBP order execution.

## Safety and scope

- All 12 asset/fiat combinations are `status: "draft"`, `channelStatus: "disabled"`, and `executionMode: "manual_record_only"`.
- No route contains or invents a rate, fee, SLA, payout provider, bank integration, or execution capability.
- USDT/USDC symbols and blockchain networks are separate. Every initial route has `network: null`; `assertDepositInstructionsAllowed` fails closed, so the catalogue cannot produce a deposit address or QR code.
- “Europe” means the **21-country euro area as of 2026-11-12**, including Bulgaria from 1 January 2026. It does not mean every European or EU country. GBP is scoped to the United Kingdom.
- Recipient validation is syntax/basic-checksum validation only. It does not prove an account or PIX key exists, belongs to the named recipient, can receive a transfer, or is sanctioned/eligible.
- The forms intentionally do not request identity-document images, SSNs, or equivalent unnecessary identifiers. Unknown fields are rejected.
- Financial and personal input is returned only as `[REDACTED]`; constant error messages do not contain submitted values. Calling applications must apply the same rule to logs and telemetry.
- Amounts are accepted only as plain decimal strings and converted to exact `bigint` minor units. Do not coerce monetary values through JavaScript `Number`.

## Files and exported API

- `routes.ts`: currency, market, route, recipient-method and field constants; exact amount helpers; CLABE, ABA, IBAN and PIX syntax checks; safe full-form validation.
- `routes.test.ts`: Node test coverage for fail-closed route state, precision, checksums, market boundaries, configurable Brazil rules, unsupported fields and redaction.

Important exports:

- `FIAT_CURRENCIES`, `SOURCE_ASSETS`, `CURRENCY_DECIMALS`
- `MARKETS`, `EURO_AREA_COUNTRIES`, `RECIPIENT_METHODS`, `ROUTES`
- `parseAmountToMinorUnits`, `formatMinorUnits`
- `validateRecipientForm`
- `assertDepositInstructionsAllowed`

Example backend validation (the result contains no raw account value):

```ts
const result = validateRecipientForm("MX_CLABE", {
  accountHolderName: request.accountHolderName,
  clabe: request.clabe,
});

if (!result.valid) return { errors: result.errors };
```

The original request body still contains sensitive values and must be handled only in an approved secrets/PII boundary; do not log it. This validator deliberately does not return normalized raw data.

## Recipient methods

| Market                   | Currency | Initial method(s)                                             | Validation                                                                |
| ------------------------ | -------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| China                    | CNY      | Account holder, bank name, bank account                       | Basic digit/length format                                                 |
| United States            | USD      | Account holder, bank name, account type, account, ABA routing | Basic account format and 9-digit ABA checksum; no active-directory lookup |
| Euro area (21 countries) | EUR      | Account holder and IBAN                                       | SWIFT country length and mod-97                                           |
| Mexico                   | MXN      | Account holder and 18-digit CLABE                             | Banco de México 3-7-1 check digit                                         |
| Brazil                   | BRL      | Configurable bank account or PIX                              | Conservative configurable bank format; DICT PIX syntax                    |
| United Kingdom           | GBP      | Sort code + account, or GB IBAN                               | Basic local format, or SWIFT country length and mod-97                    |

PIX supports `email`, E.164 `phone`, random/EVP UUID, `CPF`, and `CNPJ`. The current Banco Central do Brasil DICT CNPJ syntax is `^[A-Z0-9]{12}[0-9]{2}$`, so the validator does not incorrectly reject alphanumeric 2026 CNPJ keys. CPF/CNPJ checks here are format-only; no tax-identifier checksum, government lookup, ownership lookup, or DICT lookup is claimed.

## Suggested main-repository wiring

1. Copy or package `routes.ts` under the shared core package after code review; export its constants/types to both API and web builds.
2. Render forms directly from `RECIPIENT_METHODS[method].fields`, but run `validateRecipientForm` again on the server. Client validation is only a convenience.
3. Persist sensitive recipient values in the existing approved encrypted/PII store, never in generic logs, analytics, errors, or audit payloads. Keep validation results separate from raw input.
4. Introduce a reviewed channel configuration per market. Only that configuration may narrow Brazil formats/PIX types and eventually supply payout behavior.
5. Add an explicit `(asset, network)` registry only after networks and confirmation policies are approved. Keep deposit-address/QR generation behind both reviewed network configuration and an independently enabled channel/runtime gate.
6. Keep quote, fee, rate, limits and SLA models outside this catalogue until real providers and compliance rules are selected. Continue using exact decimal strings/`bigint` for all monetary arithmetic.
7. Run the main repository’s typecheck and full tests after integration; this isolated delivery does not claim main-repository integration.

## Still to confirm before any real-money entry can open

- Blockchain networks for USDT and USDC, token contracts, confirmations, address custody, memo/tag rules, and deposit/QR ownership.
- Payout providers/channels, their supported account formats, availability, limits, settlement behavior and active routing/account directory checks.
- Pricing/rate source, spread, fees, rounding policy, quote expiry and disclosures.
- Compliance, sanctions, KYC/KYB, data residency, retention, encryption, access control and recipient-name screening requirements in each jurisdiction.
- Manual operating controls: maker/checker roles, evidence, reconciliation, exception handling, refund handling, audit trail, and incident response.
- Provider-specific Brazil bank rules and enabled PIX key types; UK modulus checking source; US active ABA directory lookup.
- Legal confirmation that each route, market, stablecoin and operating process is permitted. Until then, keep all route/channel and real-funds runtime gates disabled.

## Official primary sources

- Banco de México, CLABE structure and official 3-7-1 check-digit procedure: <https://www.banxico.org.mx/marco-normativo/normativa-emitida-por-el-banco-de-mexico/circular-12-2018/%7BA6023AE0-8135-44ED-04DA-2068117ED5FD%7D.pdf>
- Banco de México FAQ (CLABE is 18 digits): <https://www.banxico.org.mx/footer-es/preguntas-frecuentes-dudas-ba.html>
- Banco Central do Brasil PIX FAQ: <https://www.bcb.gov.br/meubc/faqs/s/pix>
- Banco Central do Brasil DICT API (key types and current regexes): <https://www.bcb.gov.br/content/estabilidadefinanceira/pix/API-DICT.html>
- SWIFT IBAN Registry and registration-authority description: <https://www.swift.com/standards/data-standards/iban-international-bank-account-number>
- European Central Bank, current euro-area membership: <https://www.ecb.europa.eu/euro/intro/html/index.en.html>
- American Bankers Association routing-number policy (nine-digit structure/check digit and official registrar boundary): <https://www.aba.com/news-research/analysis-guides/routing-number-policy-procedures>

The official references establish format/checksum scope only. None of them makes these draft routes executable or validates a submitted recipient account.
