import assert from "node:assert/strict";
import test from "node:test";
import {
  EURO_AREA_COUNTRIES,
  MARKETS,
  RECIPIENT_METHODS,
  ROUTES,
  RouteCatalogError,
  assertDepositInstructionsAllowed,
  formatMinorUnits,
  isValidAbaRoutingNumber,
  isValidClabe,
  isValidIban,
  isValidPixKey,
  parseAmountToMinorUnits,
  validateRecipientForm,
} from "../src/route-catalog";

test("catalog has the twelve requested asset/fiat routes and every route fails closed", () => {
  assert.equal(ROUTES.length, 12);
  assert.deepEqual(
    new Set(ROUTES.map((route) => route.sourceAsset)),
    new Set(["USDT", "USDC"]),
  );
  assert.deepEqual(
    new Set(ROUTES.map((route) => route.targetCurrency)),
    new Set(["CNY", "USD", "EUR", "MXN", "BRL", "GBP"]),
  );
  for (const route of ROUTES) {
    assert.equal(route.status, "draft");
    assert.equal(route.channelStatus, "disabled");
    assert.equal(route.executionMode, "manual_record_only");
    assert.equal(route.network, null);
    assert.equal(route.rate, null);
    assert.equal(route.fee, null);
    assert.equal(route.sla, null);
  }
});

test("asset symbols do not imply networks and unconfigured routes cannot emit deposit instructions", () => {
  const route = ROUTES.find((item) => item.id === "USDT-CNY")!;
  assert.throws(
    () => assertDepositInstructionsAllowed(route, null),
    (error: unknown) =>
      error instanceof RouteCatalogError &&
      error.code === "NETWORK_UNCONFIGURED",
  );
  assert.throws(
    () =>
      assertDepositInstructionsAllowed(route, {
        asset: "USDT",
        networkId: "example",
        address: "must-not-be-used",
        enabled: true,
      }),
    (error: unknown) =>
      error instanceof RouteCatalogError &&
      error.code === "NETWORK_UNCONFIGURED",
  );
  assert.throws(
    () =>
      assertDepositInstructionsAllowed(
        {
          ...route,
          network: "sandbox",
          channelStatus: "enabled",
          status: "draft",
        },
        {
          asset: "USDT",
          networkId: "sandbox",
          address: "not-an-address",
          enabled: true,
        },
      ),
    /disabled/,
  );
});

test("money parsing is exact, precision-bound, and never coerces through Number", () => {
  const large = "90071992547409931234567890.12";
  assert.equal(
    parseAmountToMinorUnits(large, "CNY"),
    9007199254740993123456789012n,
  );
  assert.equal(
    formatMinorUnits(parseAmountToMinorUnits("1.2", "USDC"), "USDC"),
    "1.200000",
  );
  assert.throws(() => parseAmountToMinorUnits("1.001", "EUR"));
  assert.throws(() => parseAmountToMinorUnits("1e6", "USDT"));
  assert.throws(() => parseAmountToMinorUnits(1 as unknown as string, "USD"));
});

test("euro route is the 21-country euro area, not all Europe or all EU", () => {
  assert.equal(EURO_AREA_COUNTRIES.length, 21);
  assert.ok(EURO_AREA_COUNTRIES.includes("BG"));
  assert.ok(!EURO_AREA_COUNTRIES.includes("GB" as never));
  assert.equal(MARKETS.EURO_AREA.kind, "region");
  assert.equal(MARKETS.GB.fiatCurrency, "GBP");
});

test("IBAN validates country length and mod-97 and enforces the route jurisdiction", () => {
  assert.equal(
    isValidIban("DE89 3704 0044 0532 0130 00", EURO_AREA_COUNTRIES),
    true,
  );
  assert.equal(
    isValidIban("BG80 BNBG 9661 1020 3456 78", EURO_AREA_COUNTRIES),
    true,
  );
  assert.equal(
    isValidIban("GB82 WEST 1234 5698 7654 32", EURO_AREA_COUNTRIES),
    false,
  );
  assert.equal(isValidIban("GB82 WEST 1234 5698 7654 32", ["GB"]), true);
  assert.equal(
    isValidIban("DE88 3704 0044 0532 0130 00", EURO_AREA_COUNTRIES),
    false,
  );
});

test("CLABE validates the official 3-7-1 check digit", () => {
  assert.equal(isValidClabe("002180032240946700"), true);
  assert.equal(isValidClabe("002180032240946701"), false);
  assert.equal(
    validateRecipientForm("MX_CLABE", {
      accountHolderName: "Recipient",
      clabe: "002180032240946700",
    }).valid,
    true,
  );
});

test("ABA routing validation applies the nine-digit checksum without claiming directory validity", () => {
  assert.equal(isValidAbaRoutingNumber("021000021"), true);
  assert.equal(isValidAbaRoutingNumber("021000022"), false);
  const result = validateRecipientForm("US_BANK_ACCOUNT", {
    accountHolderName: "Recipient",
    bankName: "Example bank",
    abaRoutingNumber: "021000021",
    accountNumber: "12345678",
    accountType: "checking",
  });
  assert.equal(result.valid, true);
  assert.equal(
    RECIPIENT_METHODS.US_BANK_ACCOUNT.validationLevel,
    "basic_format_only",
  );
});

test("PIX accepts every official key family including alphanumeric 2026 CNPJ syntax", () => {
  assert.equal(isValidPixKey("email", "pix@example.com"), true);
  assert.equal(isValidPixKey("phone", "+5510998765432"), true);
  assert.equal(
    isValidPixKey("random", "123e4567-e89b-12d3-a456-426655440000"),
    true,
  );
  assert.equal(isValidPixKey("CPF", "12345678901"), true);
  assert.equal(isValidPixKey("CNPJ", "AB12CD34EF5601"), true);
  assert.equal(isValidPixKey("CNPJ", "AB12CD34EF56AA"), false);
});

test("PIX types and Brazil bank formats can be narrowed by future channel configuration", () => {
  const pix = validateRecipientForm(
    "BR_PIX",
    {
      accountHolderName: "Recipient",
      pixKeyType: "CNPJ",
      pixKey: "AB12CD34EF5601",
    },
    { enabledPixKeyTypes: ["email"] },
  );
  assert.equal(pix.valid, false);
  assert.ok(pix.errors.some((error) => error.code === "DISABLED_OPTION"));

  const bank = validateRecipientForm(
    "BR_BANK_ACCOUNT",
    {
      accountHolderName: "Recipient",
      bankCode: "123",
      branchNumber: "42",
      accountNumber: "ABC-9",
      accountType: "payment",
    },
    { brazilBank: { accountNumber: /^\d+$/, accountTypes: ["checking"] } },
  );
  assert.equal(bank.valid, false);
  assert.deepEqual(
    new Set(bank.errors.map((error) => error.field)),
    new Set(["accountNumber", "accountType"]),
  );
});

test("UK local and IBAN methods are separate conservative choices", () => {
  assert.equal(
    validateRecipientForm("GB_LOCAL_ACCOUNT", {
      accountHolderName: "Recipient",
      sortCode: "12-34-56",
      accountNumber: "12345678",
    }).valid,
    true,
  );
  assert.equal(
    validateRecipientForm("GB_IBAN", {
      accountHolderName: "Recipient",
      iban: "GB82 WEST 1234 5698 7654 32",
    }).valid,
    true,
  );
});

test("China fields are minimal and basic format validation rejects account text", () => {
  assert.deepEqual(
    RECIPIENT_METHODS.CN_BANK_ACCOUNT.fields.map((field) => field.id),
    ["accountHolderName", "bankName", "accountNumber"],
  );
  assert.equal(
    validateRecipientForm("CN_BANK_ACCOUNT", {
      accountHolderName: "Recipient",
      bankName: "Bank",
      accountNumber: "1234-5678-9012",
    }).valid,
    true,
  );
  assert.equal(
    validateRecipientForm("CN_BANK_ACCOUNT", {
      accountHolderName: "Recipient",
      bankName: "Bank",
      accountNumber: "1234-secret",
    }).valid,
    false,
  );
});

test("validation errors and outputs never echo financial or personal input", () => {
  const secret = "SECRET-PIX-VALUE";
  const result = validateRecipientForm("BR_PIX", {
    accountHolderName: "Private Recipient",
    pixKeyType: "email",
    pixKey: secret,
  });
  assert.equal(result.valid, false);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(secret));
  assert.ok(!serialized.includes("Private Recipient"));
  assert.deepEqual(result.safeFields, [
    { field: "accountHolderName", value: "[REDACTED]" },
    { field: "pixKeyType", value: "email" },
    { field: "pixKey", value: "[REDACTED]" },
  ]);
});

test("undefined fields such as SSN and identity files are rejected rather than collected", () => {
  const result = validateRecipientForm("US_BANK_ACCOUNT", {
    accountHolderName: "Recipient",
    bankName: "Bank",
    abaRoutingNumber: "021000021",
    accountNumber: "12345678",
    accountType: "checking",
    ssn: "must-not-be-collected",
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "UNSUPPORTED_FIELD"));
  assert.ok(!JSON.stringify(result).includes("must-not-be-collected"));
});
