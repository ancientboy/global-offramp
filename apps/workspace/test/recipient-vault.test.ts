import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { RecipientVault } from "../src/recipient-vault";
test("recipient ciphertext is scoped to customer, account token, country, currency and method", () => {
  const vault = new RecipientVault(randomBytes(32)),
    scope = {
      customerId: "customer-a",
      country: "CN",
      currency: "CNY",
      accountToken: "private-token",
    },
    fields = {
      accountHolderName: "Private holder",
      accountNumber: "6222021000001234567",
    };
  const encrypted = vault.seal(scope, {
      country: "CN",
      currency: "CNY",
      method: "CN_BANK_ACCOUNT",
      fields,
    }),
    stored = {
      ...scope,
      recipientAccount: { method: "CN_BANK_ACCOUNT", encrypted },
    };
  assert.ok(!encrypted.includes(fields.accountNumber));
  assert.deepEqual(vault.open(stored), fields);
  for (const changed of [
    { customerId: "customer-b" },
    { country: "US" },
    { currency: "USD" },
    { accountToken: "different" },
  ])
    assert.throws(() => vault.open({ ...stored, ...changed }));
  assert.throws(() => new RecipientVault(randomBytes(32)).open(stored));
});
