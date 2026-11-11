# Merchant batch workbook

Download `/templates/merchant-batch-template.xlsx`. The workbook contains a synthetic row and Chinese instructions. Replace or delete the example. Only the selected company customer owns a batch; row-level customer or beneficiary IDs are rejected.

Required columns: 姓名, 银行, 银行卡号, 到账金额, 到账币种. Optional: 支付币种（选填）, 商户行号（选填）. Preserve all seven headers. Account cells must be native text; the template reserves text format `@` for rows 2–101 and contains the exact synthetic string `0012345678901234567`. Numeric cells, scientific notation, formulas and complex cell objects are rejected rather than guessing digits. Amount means target fiat payout, not stablecoin principal. CNY/USD and USDT/USDC are supported; source defaults to USDT.

The browser reads and displays masked local previews. Only explicit confirmation sends parsed rows to `POST /batches/merchant`. Same customer + clientBatchId + payload is idempotent; changing content under the same key conflicts. Invalid rows persist only safe error metadata, never recipients or orders. Valid rows create customer-scoped saved demo recipients; quote and submission use `target_payout` exact-decimal reverse pricing. Wallet submission retains the existing quote-ID and atomic-balance guards. Legacy `POST /batches` principal CSV is unchanged.

This remains a simulation: complete account numbers are not persisted, transmitted to banks, or recoverable for manual payment. Only a mask and random demo token are stored. Production bank execution requires a separate authorized secure account vault and bank integration. Never upload actual personal or banking data to this demo.

Parser limits: 2MB compressed, 256 archive entries, 5MB per expanded entry, 15MB total expanded data, maximum compression ratio 200 for entries over 100KB. Central/local metadata is checked and actual streamed decompression counted before ExcelJS loads data. Macro, external-link, embedded-file and media paths are rejected. This is not a general-purpose malware scanner.

## Regenerate the static workbook

The workbook is authored by `scripts/build-merchant-template.mjs` with the provided artifact-tool runtime. Run a copy from a temporary folder with the runtime node_modules symlink, passing an absolute output directory. Then run:

    python scripts/normalize-template-xml.py OUTPUT/merchant-batch-template.xlsx
    cp OUTPUT/merchant-batch-template.xlsx apps/web/public/templates/

The normalization only changes equivalent OpenXML namespace spelling because ExcelJS does not parse the artifact export's prefixed spreadsheet namespace. Cell types, text values, formats, and validations remain unchanged. Verify the downloadable bytes with `apps/web/test/merchant-workbook.test.ts`. The artifact preview renderer displays the numeric-looking text example in scientific notation even though exported OpenXML and ExcelJS both confirm native string `0012345678901234567` and `@`; don't use that renderer output as the account data source.
