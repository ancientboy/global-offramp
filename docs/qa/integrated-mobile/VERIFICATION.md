# Final integrated phone-width verification

Verified 2026-10-13, 08:39–08:47 UTC, using supported cloud Chrome UI controls against the exact final deployed artifact from commit `1b6eeaddea5380d2c6d350b53382decc37c037e8`.

## Method and limits

- Final `dist/client` static Next export and `dist/server/index.js` bundled Worker were served together by a loopback-only Node QA harness. No frontend state fixture or alternative API implementation was substituted.
- Harness binds only `127.0.0.1:4147`, maps the local HTTP request and exact matching Origin to virtual HTTPS for the Worker, and serves the exact static asset bytes. Browser cookies and UI-to-Worker requests were used. Production Site access settings were not altered.
- Cloud Chromium native window resizing and browser zoom produced 405 × 606 and 391 × 505 CSS-pixel viewports. Vertical desktop scrollbars leave usable widths of 393 and 381 CSS pixels respectively. This is responsive phone-width verification, not Android hardware, touch, keyboard or accessibility certification.
- Worker SHA-256: `af701b36b88f612d4b7c2aff51c58c808af30f273e0b47ef558d07acde73c8e6`.
- No app code changes were needed. Hosted URL and deployed version are unchanged.

## Passed through actual browser interactions

1. Customer default total-deposit quote: 1000 USDT, fees 5 + 2, principal 993, payout 7149.60 CNY. Back to form, requote and re-enter confirmation retained the exact amount.
2. Required acknowledgment enabled order creation; order persisted in Worker session, with independent awaiting-deposit, draft-payout and no-receipt state.
3. Operations submitted a signed synthetic deposit; finance separately recorded the mock conversion. Maker submitted payout; only the separate finance identity exposed approval.
4. After approval, maker recorded unknown result. Repeat-payment and refund controls were absent; clear verification warning remained visible.
5. Finance independently resolved the result as sent. Receipt metadata could be registered afterward without changing payout state. Independent reconciliation succeeded.
6. Partner displayed only masked customer alias and the sample 1.00 USDT commission on 5.00 USDT eligible service fee at 20%, under the seven-day observation period. Partner commission and settlement navigation worked. No eligible settlement was invented.
7. Reset visible only to maker in hosted-session mode. Cancel preserved the one order. Confirm cleared orders and UI caches, and customer quoting worked again.
8. Payment, confirmation, order, operations, partner overview/commission/settlements, and reset screens had document scrollWidth equal to clientWidth at the measured phone widths. Wide data tables and admin navigation have contained horizontal scrolling rather than document overflow.
9. Dialogs remained readable and their confirmation/cancel actions usable; taller finance forms scroll within the dialog.

## Evidence

The JPEG files in this directory are real cloud-browser screenshots, not renders from code. The desktop browser extension emitted metadata errors unrelated to the app; no application-origin console warnings or errors were observed in the available log capture. The browser QA session's synthetic state was reset, and the loopback server was stopped after verification.

## Remaining verification

Actual Android Chrome, touch gestures, virtual keyboard overlap, device safe areas, assistive technology, full file-upload/download flows, and a device/browser matrix remain untested. The hosted private sign-in gate is separate from this local artifact test; its API and cookie isolation passed seven hosted smoke checks before this pass.
