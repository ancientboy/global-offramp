# Synthetic OCR fixture

`synthetic-receipt.png` is a generated white-background Chinese receipt with entirely invented values. It contains no uploaded receipt or customer data.

Run `npm run test:ocr` from the integrated app root. This prepares local models then executes Tesseract WASM locally against this fixture and asserts eight extracted fields. `npm test` also covers strict parsing, two-currency semantics, table row identity isolation, column-order ambiguity, low confidence, and size/type bounds.

The browser uses the same engine and model versions. `/ocr/worker.min.js`, WASM and Chinese/English trained data are copied from locked npm dependencies during builds. No CDN or remote OCR API is configured. Generated OCR assets are ignored by Git. Production exports must include `apps/web/public/ocr` through the Next static output.

Photographed screens may have moiré and poor OCR. Low-confidence input receives one bounded local contrast-enhancement pass. Missing/conflicting label-backed fields stay empty. Table row extraction can miss rows or identity fields; administrators must compare the original and manually correct/add rows. OCR never verifies a bank, payment or receipt authenticity.
