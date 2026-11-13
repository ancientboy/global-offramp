import test from "node:test";
import assert from "node:assert/strict";
import {
  validateFullRecipient,
  validBrazilTaxId,
  type FullRecipientInput,
} from "../src/recipient-account";
import { examples } from "./fixtures/recipient-accounts";
test("all six countries and eight account methods require method-specific complete fields and retain leading zeros", () => {
  for (const input of examples) {
    const r = validateFullRecipient(input);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
    const missing = {
      ...input,
      fields: { ...input.fields, accountHolderName: "" },
    };
    assert.equal(validateFullRecipient(missing).valid, false);
  }
  assert.equal(
    validateFullRecipient(examples[1]).fields.accountNumber,
    "000123456789",
  );
  assert.equal(validateFullRecipient(examples[6]).fields.sortCode, "123456");
});
test("country mismatch, bad checksums, missing bank fields and unknown fields are rejected without echoing sensitive input", () => {
  for (const [index, key, value] of [
    [1, "abaRoutingNumber", "021000022"],
    [2, "iban", "DE89370400440532013001"],
    [3, "clabe", "032180000118359710"],
    [4, "taxId", "00000000000"],
    [6, "sortCode", "123"],
  ] as const) {
    const v = validateFullRecipient({
      ...examples[index],
      fields: { ...examples[index].fields, [key]: value },
    });
    assert.equal(v.valid, false);
    assert.ok(!JSON.stringify(v.errors).includes(value));
  }
  assert.equal(
    validateFullRecipient({ ...examples[2], country: "FR" }).valid,
    false,
  );
  assert.equal(
    validateFullRecipient({
      ...examples[0],
      fields: { ...examples[0].fields, branchName: "" },
    }).valid,
    false,
  );
  assert.equal(
    validateFullRecipient({
      ...examples[0],
      fields: { ...examples[0].fields, unexpected: "secret" },
    }).valid,
    false,
  );
});
test("CPF and both numeric and 2026 alphanumeric CNPJ check digits are validated", () => {
  assert.equal(validBrazilTaxId("52998224725"), true);
  assert.equal(validBrazilTaxId("11444777000161"), true);
  assert.equal(validBrazilTaxId("12ABC34501DE35"), true);
  assert.equal(validBrazilTaxId("12ABC34501DE36"), false);
});
