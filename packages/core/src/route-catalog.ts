/**
 * Draft-only global off-ramp route catalogue and conservative recipient-field validation.
 *
 * This module deliberately contains no rates, fees, SLAs, payout adapters, deposit
 * addresses, or QR generation. Monetary inputs are decimal strings and are converted
 * to bigint minor units; JavaScript Number is never used for money arithmetic.
 */

export const FIAT_CURRENCIES = {
  CNY: { symbol: "CNY", name: "Chinese yuan", decimalPlaces: 2 },
  USD: { symbol: "USD", name: "US dollar", decimalPlaces: 2 },
  EUR: { symbol: "EUR", name: "Euro", decimalPlaces: 2 },
  MXN: { symbol: "MXN", name: "Mexican peso", decimalPlaces: 2 },
  BRL: { symbol: "BRL", name: "Brazilian real", decimalPlaces: 2 },
  GBP: { symbol: "GBP", name: "Pound sterling", decimalPlaces: 2 },
} as const;

export const SOURCE_ASSETS = {
  USDT: { symbol: "USDT", name: "Tether USD", decimalPlaces: 6 },
  USDC: { symbol: "USDC", name: "USD Coin", decimalPlaces: 6 },
} as const;

export type FiatCurrency = keyof typeof FIAT_CURRENCIES;
export type SourceAsset = keyof typeof SOURCE_ASSETS;
export type CurrencySymbol = FiatCurrency | SourceAsset;

export const CURRENCY_DECIMALS: Readonly<Record<CurrencySymbol, number>> = {
  CNY: 2,
  USD: 2,
  EUR: 2,
  MXN: 2,
  BRL: 2,
  GBP: 2,
  USDT: 6,
  USDC: 6,
};

export type MarketCode = "CN" | "US" | "EURO_AREA" | "MX" | "BR" | "GB";
export type CountryCode =
  | "AT"
  | "BE"
  | "BG"
  | "HR"
  | "CY"
  | "EE"
  | "FI"
  | "FR"
  | "DE"
  | "GR"
  | "IE"
  | "IT"
  | "LV"
  | "LT"
  | "LU"
  | "MT"
  | "NL"
  | "PT"
  | "SK"
  | "SI"
  | "ES"
  | "CN"
  | "US"
  | "MX"
  | "BR"
  | "GB";

/** Euro-area membership as of 2026-11-12. This is intentionally not all of Europe or all of the EU. */
export const EURO_AREA_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PT",
  "SK",
  "SI",
  "ES",
] as const satisfies readonly CountryCode[];

/** IBAN lengths from the SWIFT IBAN Registry for only the currently supported jurisdictions. */
export const IBAN_LENGTH_BY_COUNTRY = {
  AT: 20,
  BE: 16,
  BG: 22,
  HR: 21,
  CY: 28,
  EE: 20,
  FI: 18,
  FR: 27,
  DE: 22,
  GR: 27,
  IE: 22,
  IT: 27,
  LV: 21,
  LT: 20,
  LU: 20,
  MT: 31,
  NL: 18,
  PT: 25,
  SK: 24,
  SI: 19,
  ES: 24,
  GB: 22,
} as const;

export type RecipientMethodId =
  | "CN_BANK_ACCOUNT"
  | "US_BANK_ACCOUNT"
  | "EUR_IBAN"
  | "MX_CLABE"
  | "BR_BANK_ACCOUNT"
  | "BR_PIX"
  | "GB_LOCAL_ACCOUNT"
  | "GB_IBAN";

export type FieldId =
  | "accountHolderName"
  | "bankName"
  | "accountNumber"
  | "accountType"
  | "abaRoutingNumber"
  | "iban"
  | "clabe"
  | "bankCode"
  | "branchNumber"
  | "pixKeyType"
  | "pixKey"
  | "sortCode";

export interface RecipientFieldDescriptor {
  readonly id: FieldId;
  readonly label: string;
  readonly required: boolean;
  readonly sensitivity: "personal" | "financial" | "non_sensitive";
  readonly inputMode: "text" | "numeric" | "email" | "tel" | "select";
  readonly options?: readonly string[];
  readonly description: string;
}

export interface RecipientMethodDefinition {
  readonly id: RecipientMethodId;
  readonly label: string;
  readonly fields: readonly RecipientFieldDescriptor[];
  readonly validationLevel: "basic_format_only";
  readonly warning: string;
}

const holderName: RecipientFieldDescriptor = {
  id: "accountHolderName",
  label: "Account holder name",
  required: true,
  sensitivity: "personal",
  inputMode: "text",
  description:
    "Recipient name as held by the bank; no identity-document image is requested.",
};

const bankName: RecipientFieldDescriptor = {
  id: "bankName",
  label: "Bank name",
  required: true,
  sensitivity: "non_sensitive",
  inputMode: "text",
  description:
    "Bank name supplied by the recipient; not proof that the account exists.",
};

const formatOnlyWarning =
  "Format validation only. It does not prove account ownership, existence, reachability, or eligibility for payment.";

export const RECIPIENT_METHODS: Readonly<
  Record<RecipientMethodId, RecipientMethodDefinition>
> = {
  CN_BANK_ACCOUNT: {
    id: "CN_BANK_ACCOUNT",
    label: "China bank account",
    validationLevel: "basic_format_only",
    warning: formatOnlyWarning,
    fields: [
      holderName,
      bankName,
      {
        id: "accountNumber",
        label: "Bank account number",
        required: true,
        sensitivity: "financial",
        inputMode: "numeric",
        description:
          "8-34 digits; spaces and hyphens are removed before format validation.",
      },
    ],
  },
  US_BANK_ACCOUNT: {
    id: "US_BANK_ACCOUNT",
    label: "United States bank account",
    validationLevel: "basic_format_only",
    warning: formatOnlyWarning,
    fields: [
      holderName,
      bankName,
      {
        id: "abaRoutingNumber",
        label: "ABA routing number",
        required: true,
        sensitivity: "financial",
        inputMode: "numeric",
        description:
          "Nine digits with the ABA checksum; no active-routing-directory lookup is performed.",
      },
      {
        id: "accountNumber",
        label: "Bank account number",
        required: true,
        sensitivity: "financial",
        inputMode: "numeric",
        description:
          "4-17 digits; provider-specific constraints remain to be confirmed.",
      },
      {
        id: "accountType",
        label: "Account type",
        required: true,
        sensitivity: "non_sensitive",
        inputMode: "select",
        options: ["checking", "savings"],
        description: "Basic US account classification.",
      },
    ],
  },
  EUR_IBAN: {
    id: "EUR_IBAN",
    label: "Euro-area IBAN",
    validationLevel: "basic_format_only",
    warning: formatOnlyWarning,
    fields: [
      holderName,
      {
        id: "iban",
        label: "IBAN",
        required: true,
        sensitivity: "financial",
        inputMode: "text",
        description:
          "Country-specific length plus ISO 7064 mod-97 check, limited to the 21-country euro area.",
      },
    ],
  },
  MX_CLABE: {
    id: "MX_CLABE",
    label: "Mexico CLABE",
    validationLevel: "basic_format_only",
    warning: formatOnlyWarning,
    fields: [
      holderName,
      {
        id: "clabe",
        label: "CLABE",
        required: true,
        sensitivity: "financial",
        inputMode: "numeric",
        description: "18 digits including the official weighted check digit.",
      },
    ],
  },
  BR_BANK_ACCOUNT: {
    id: "BR_BANK_ACCOUNT",
    label: "Brazil bank account",
    validationLevel: "basic_format_only",
    warning: formatOnlyWarning,
    fields: [
      holderName,
      {
        id: "bankCode",
        label: "Bank code",
        required: true,
        sensitivity: "financial",
        inputMode: "text",
        description:
          "Basic 3-8 character code; may be overridden for a selected payout channel.",
      },
      {
        id: "branchNumber",
        label: "Branch number",
        required: true,
        sensitivity: "financial",
        inputMode: "text",
        description:
          "Basic 1-10 character format; channel-specific rules are configurable.",
      },
      {
        id: "accountNumber",
        label: "Bank account number",
        required: true,
        sensitivity: "financial",
        inputMode: "text",
        description:
          "Basic 1-20 character format; channel-specific rules are configurable.",
      },
      {
        id: "accountType",
        label: "Account type",
        required: true,
        sensitivity: "non_sensitive",
        inputMode: "select",
        options: ["checking", "savings", "payment"],
        description:
          "Configurable account classification for a future payout channel.",
      },
    ],
  },
  BR_PIX: {
    id: "BR_PIX",
    label: "Brazil PIX key",
    validationLevel: "basic_format_only",
    warning: formatOnlyWarning,
    fields: [
      holderName,
      {
        id: "pixKeyType",
        label: "PIX key type",
        required: true,
        sensitivity: "non_sensitive",
        inputMode: "select",
        options: ["email", "phone", "random", "CPF", "CNPJ"],
        description:
          "DICT key type. CPF/CNPJ checks here are syntax-only, not registry or ownership checks.",
      },
      {
        id: "pixKey",
        label: "PIX key",
        required: true,
        sensitivity: "financial",
        inputMode: "text",
        description:
          "Validated against the selected DICT key type and never echoed in validation output.",
      },
    ],
  },
  GB_LOCAL_ACCOUNT: {
    id: "GB_LOCAL_ACCOUNT",
    label: "United Kingdom sort code and account",
    validationLevel: "basic_format_only",
    warning: formatOnlyWarning,
    fields: [
      holderName,
      {
        id: "sortCode",
        label: "Sort code",
        required: true,
        sensitivity: "financial",
        inputMode: "numeric",
        description: "Six digits; spaces and hyphens are removed.",
      },
      {
        id: "accountNumber",
        label: "Account number",
        required: true,
        sensitivity: "financial",
        inputMode: "numeric",
        description:
          "Eight digits. Modulus checking is not claimed without a channel data source.",
      },
    ],
  },
  GB_IBAN: {
    id: "GB_IBAN",
    label: "United Kingdom IBAN",
    validationLevel: "basic_format_only",
    warning: formatOnlyWarning,
    fields: [
      holderName,
      {
        id: "iban",
        label: "IBAN",
        required: true,
        sensitivity: "financial",
        inputMode: "text",
        description: "GB country length plus ISO 7064 mod-97 check.",
      },
    ],
  },
};

export interface MarketDefinition {
  readonly code: MarketCode;
  readonly kind: "country" | "region";
  readonly label: string;
  readonly countries: readonly CountryCode[];
  readonly fiatCurrency: FiatCurrency;
  readonly recipientMethods: readonly RecipientMethodId[];
}

export const MARKETS: Readonly<Record<MarketCode, MarketDefinition>> = {
  CN: {
    code: "CN",
    kind: "country",
    label: "China",
    countries: ["CN"],
    fiatCurrency: "CNY",
    recipientMethods: ["CN_BANK_ACCOUNT"],
  },
  US: {
    code: "US",
    kind: "country",
    label: "United States",
    countries: ["US"],
    fiatCurrency: "USD",
    recipientMethods: ["US_BANK_ACCOUNT"],
  },
  EURO_AREA: {
    code: "EURO_AREA",
    kind: "region",
    label: "Euro area",
    countries: EURO_AREA_COUNTRIES,
    fiatCurrency: "EUR",
    recipientMethods: ["EUR_IBAN"],
  },
  MX: {
    code: "MX",
    kind: "country",
    label: "Mexico",
    countries: ["MX"],
    fiatCurrency: "MXN",
    recipientMethods: ["MX_CLABE"],
  },
  BR: {
    code: "BR",
    kind: "country",
    label: "Brazil",
    countries: ["BR"],
    fiatCurrency: "BRL",
    recipientMethods: ["BR_BANK_ACCOUNT", "BR_PIX"],
  },
  GB: {
    code: "GB",
    kind: "country",
    label: "United Kingdom",
    countries: ["GB"],
    fiatCurrency: "GBP",
    recipientMethods: ["GB_LOCAL_ACCOUNT", "GB_IBAN"],
  },
};

export interface RouteDefinition {
  readonly id: `${SourceAsset}-${FiatCurrency}`;
  readonly sourceAsset: SourceAsset;
  /** Network is independent of the asset symbol and intentionally unconfigured. */
  readonly network: string | null;
  readonly targetCurrency: FiatCurrency;
  readonly market: MarketCode;
  readonly status: "draft" | "active";
  readonly channelStatus: "disabled" | "enabled";
  readonly executionMode: "manual_record_only";
  readonly recipientMethods: readonly RecipientMethodId[];
  readonly rate: null;
  readonly fee: null;
  readonly sla: null;
}

const marketByCurrency: Readonly<Record<FiatCurrency, MarketCode>> = {
  CNY: "CN",
  USD: "US",
  EUR: "EURO_AREA",
  MXN: "MX",
  BRL: "BR",
  GBP: "GB",
};

function makeRoute(
  sourceAsset: SourceAsset,
  targetCurrency: FiatCurrency,
): RouteDefinition {
  const market = marketByCurrency[targetCurrency];
  return Object.freeze({
    id: `${sourceAsset}-${targetCurrency}`,
    sourceAsset,
    network: null,
    targetCurrency,
    market,
    status: "draft",
    channelStatus: "disabled",
    executionMode: "manual_record_only",
    recipientMethods: MARKETS[market].recipientMethods,
    rate: null,
    fee: null,
    sla: null,
  });
}

export const ROUTES: readonly RouteDefinition[] = Object.freeze(
  (Object.keys(SOURCE_ASSETS) as SourceAsset[]).flatMap((asset) =>
    (Object.keys(FIAT_CURRENCIES) as FiatCurrency[]).map((fiat) =>
      makeRoute(asset, fiat),
    ),
  ),
);

export class RouteCatalogError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RouteCatalogError";
  }
}

/** Converts an unsigned decimal string to exact minor units. */
export function parseAmountToMinorUnits(
  value: string,
  currency: CurrencySymbol,
): bigint {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,29})(?:\.\d+)?$/.test(value)
  ) {
    throw new RouteCatalogError(
      "INVALID_AMOUNT",
      "Amount must be an unsigned plain decimal string.",
    );
  }
  const scale = CURRENCY_DECIMALS[currency];
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > scale) {
    throw new RouteCatalogError(
      "AMOUNT_PRECISION",
      `Amount exceeds the ${scale}-decimal precision for ${currency}.`,
    );
  }
  return (
    BigInt(whole) * BigInt(10) ** BigInt(scale) +
    BigInt(fraction.padEnd(scale, "0") || "0")
  );
}

export function formatMinorUnits(
  value: bigint,
  currency: CurrencySymbol,
): string {
  const scale = CURRENCY_DECIMALS[currency];
  const factor = BigInt(10) ** BigInt(scale);
  const sign = value < BigInt(0) ? "-" : "";
  const absolute = value < BigInt(0) ? -value : value;
  return `${sign}${absolute / factor}.${(absolute % factor).toString().padStart(scale, "0")}`;
}

export interface DepositNetworkConfiguration {
  readonly asset: SourceAsset;
  readonly networkId: string;
  readonly address: string;
  readonly enabled: boolean;
}

/**
 * Fail-closed guard for future address/QR builders. Initial catalogue entries can
 * never pass because every route has a null network and a disabled channel.
 */
export function assertDepositInstructionsAllowed(
  route: RouteDefinition,
  network: DepositNetworkConfiguration | null | undefined,
): asserts network is DepositNetworkConfiguration {
  if (!network || !route.network) {
    throw new RouteCatalogError(
      "NETWORK_UNCONFIGURED",
      "A reviewed network configuration is required before deposit instructions can be created.",
    );
  }
  if (
    network.asset !== route.sourceAsset ||
    network.networkId !== route.network
  ) {
    throw new RouteCatalogError(
      "NETWORK_MISMATCH",
      "The network configuration does not match the selected route.",
    );
  }
  if (
    !network.enabled ||
    route.channelStatus !== "enabled" ||
    route.status !== "active"
  ) {
    throw new RouteCatalogError(
      "DEPOSIT_DISABLED",
      "Deposit instructions are disabled for this route.",
    );
  }
}

export interface ValidationError {
  readonly field: FieldId | "form";
  readonly code: string;
  /** Safe, constant text: never contains the submitted value. */
  readonly message: string;
}

export interface SafeFieldOutput {
  readonly field: FieldId;
  readonly value: string;
}

export interface RecipientValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ValidationError[];
  /** Financial and personal values are always fixed-token redacted. */
  readonly safeFields: readonly SafeFieldOutput[];
}

export interface BrazilBankValidationConfig {
  readonly bankCode?: RegExp;
  readonly branchNumber?: RegExp;
  readonly accountNumber?: RegExp;
  readonly accountTypes?: readonly string[];
}

export interface RecipientValidationOptions {
  readonly brazilBank?: BrazilBankValidationConfig;
  readonly enabledPixKeyTypes?: readonly (
    "email" | "phone" | "random" | "CPF" | "CNPJ"
  )[];
}

type FormInput = Readonly<Record<string, unknown>>;

const digitsOnly = (value: string): string => value.replace(/[\s-]/g, "");
const compactIban = (value: string): string =>
  value.replace(/\s/g, "").toUpperCase();

function stringValue(input: FormInput, field: FieldId): string | undefined {
  const value = input[field];
  return typeof value === "string" ? value.trim() : undefined;
}

function addError(
  errors: ValidationError[],
  field: FieldId | "form",
  code: string,
  message: string,
): void {
  errors.push({ field, code, message });
}

function requiredString(
  input: FormInput,
  field: FieldId,
  errors: ValidationError[],
): string | undefined {
  const value = stringValue(input, field);
  if (!value)
    addError(
      errors,
      field,
      "REQUIRED",
      "A required recipient field is missing.",
    );
  return value || undefined;
}

/** ABA nine-digit checksum. Passing it does not prove the routing number is active. */
export function isValidAbaRoutingNumber(value: string): boolean {
  const digits = digitsOnly(value);
  if (!/^\d{9}$/.test(digits)) return false;
  const weights = [3, 7, 1] as const;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1)
    sum += Number(digits[i]) * weights[i % 3];
  return sum % 10 === 0;
}

/** Banco de México CLABE check digit algorithm: positions 1-17 weighted 3,7,1. */
export function isValidClabe(value: string): boolean {
  const digits = digitsOnly(value);
  if (!/^\d{18}$/.test(digits)) return false;
  const weights = [3, 7, 1] as const;
  let sum = 0;
  for (let i = 0; i < 17; i += 1)
    sum += (Number(digits[i]) * weights[i % 3]) % 10;
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === Number(digits[17]);
}

function ibanMod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const expanded = /[A-Z]/.test(character)
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of expanded)
      remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

export function isValidIban(
  value: string,
  allowedCountries: readonly CountryCode[],
): boolean {
  const iban = compactIban(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const country = iban.slice(0, 2) as keyof typeof IBAN_LENGTH_BY_COUNTRY;
  if (!allowedCountries.includes(country as CountryCode)) return false;
  const expectedLength = IBAN_LENGTH_BY_COUNTRY[country];
  return (
    expectedLength !== undefined &&
    iban.length === expectedLength &&
    ibanMod97(iban) === 1
  );
}

export type PixKeyType = "email" | "phone" | "random" | "CPF" | "CNPJ";

/** DICT syntax only; CPF/CNPJ ownership and registry validity are deliberately not claimed. */
export function isValidPixKey(type: PixKeyType, rawValue: string): boolean {
  const value = rawValue.trim();
  switch (type) {
    case "email":
      return (
        value.length <= 77 &&
        /^[a-z0-9.!#$'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(
          value,
        )
      );
    case "phone":
      return /^\+[1-9]\d{1,14}$/.test(value);
    case "random":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value,
      );
    case "CPF":
      return /^\d{11}$/.test(value);
    case "CNPJ":
      // Current BCB DICT syntax permits alphanumeric first 12 characters.
      return /^[A-Z0-9]{12}[0-9]{2}$/.test(value);
  }
}

function validateKnownFields(
  method: RecipientMethodDefinition,
  input: FormInput,
  errors: ValidationError[],
): void {
  const allowed = new Set(method.fields.map((field) => field.id));
  for (const key of Object.keys(input)) {
    if (!allowed.has(key as FieldId)) {
      addError(
        errors,
        "form",
        "UNSUPPORTED_FIELD",
        "The form contains a field not defined for this recipient method.",
      );
    }
  }
}

function validateName(
  value: string | undefined,
  errors: ValidationError[],
): void {
  if (value && (value.length > 100 || /[\u0000-\u001f\u007f]/.test(value))) {
    addError(
      errors,
      "accountHolderName",
      "INVALID_FORMAT",
      "The account holder name has an invalid basic format.",
    );
  }
}

export function validateRecipientForm(
  methodId: RecipientMethodId,
  input: FormInput,
  options: RecipientValidationOptions = {},
): RecipientValidationResult {
  const method = RECIPIENT_METHODS[methodId];
  const errors: ValidationError[] = [];
  validateKnownFields(method, input, errors);

  const name = requiredString(input, "accountHolderName", errors);
  validateName(name, errors);

  if (methodId === "CN_BANK_ACCOUNT") {
    const bank = requiredString(input, "bankName", errors);
    const account = requiredString(input, "accountNumber", errors);
    if (bank && (bank.length > 100 || /[\u0000-\u001f\u007f]/.test(bank)))
      addError(
        errors,
        "bankName",
        "INVALID_FORMAT",
        "The bank name has an invalid basic format.",
      );
    if (account && !/^\d{8,34}$/.test(digitsOnly(account)))
      addError(
        errors,
        "accountNumber",
        "INVALID_FORMAT",
        "The bank account number has an invalid basic format.",
      );
  } else if (methodId === "US_BANK_ACCOUNT") {
    const bank = requiredString(input, "bankName", errors);
    const routing = requiredString(input, "abaRoutingNumber", errors);
    const account = requiredString(input, "accountNumber", errors);
    const type = requiredString(input, "accountType", errors);
    if (bank && (bank.length > 100 || /[\u0000-\u001f\u007f]/.test(bank)))
      addError(
        errors,
        "bankName",
        "INVALID_FORMAT",
        "The bank name has an invalid basic format.",
      );
    if (routing && !isValidAbaRoutingNumber(routing))
      addError(
        errors,
        "abaRoutingNumber",
        "INVALID_CHECKSUM",
        "The ABA routing number has an invalid basic format or checksum.",
      );
    if (account && !/^\d{4,17}$/.test(digitsOnly(account)))
      addError(
        errors,
        "accountNumber",
        "INVALID_FORMAT",
        "The bank account number has an invalid basic format.",
      );
    if (type && !["checking", "savings"].includes(type))
      addError(
        errors,
        "accountType",
        "INVALID_OPTION",
        "The account type is not supported.",
      );
  } else if (methodId === "EUR_IBAN") {
    const iban = requiredString(input, "iban", errors);
    if (iban && !isValidIban(iban, EURO_AREA_COUNTRIES))
      addError(
        errors,
        "iban",
        "INVALID_IBAN",
        "The IBAN has an invalid country, length, or checksum for the euro-area route.",
      );
  } else if (methodId === "MX_CLABE") {
    const clabe = requiredString(input, "clabe", errors);
    if (clabe && !isValidClabe(clabe))
      addError(
        errors,
        "clabe",
        "INVALID_CHECKSUM",
        "The CLABE has an invalid length, format, or check digit.",
      );
  } else if (methodId === "BR_BANK_ACCOUNT") {
    const config = options.brazilBank ?? {};
    const code = requiredString(input, "bankCode", errors);
    const branch = requiredString(input, "branchNumber", errors);
    const account = requiredString(input, "accountNumber", errors);
    const type = requiredString(input, "accountType", errors);
    if (code && !(config.bankCode ?? /^[A-Z0-9]{3,8}$/i).test(code))
      addError(
        errors,
        "bankCode",
        "INVALID_FORMAT",
        "The bank code has an invalid configured format.",
      );
    if (branch && !(config.branchNumber ?? /^[A-Z0-9-]{1,10}$/i).test(branch))
      addError(
        errors,
        "branchNumber",
        "INVALID_FORMAT",
        "The branch number has an invalid configured format.",
      );
    if (
      account &&
      !(config.accountNumber ?? /^[A-Z0-9-]{1,20}$/i).test(account)
    )
      addError(
        errors,
        "accountNumber",
        "INVALID_FORMAT",
        "The bank account number has an invalid configured format.",
      );
    if (
      type &&
      !(config.accountTypes ?? ["checking", "savings", "payment"]).includes(
        type,
      )
    )
      addError(
        errors,
        "accountType",
        "INVALID_OPTION",
        "The account type is not enabled by the configured channel.",
      );
  } else if (methodId === "BR_PIX") {
    const typeValue = requiredString(input, "pixKeyType", errors);
    const key = requiredString(input, "pixKey", errors);
    const supported: readonly PixKeyType[] = [
      "email",
      "phone",
      "random",
      "CPF",
      "CNPJ",
    ];
    const enabled = options.enabledPixKeyTypes ?? supported;
    if (typeValue && !supported.includes(typeValue as PixKeyType)) {
      addError(
        errors,
        "pixKeyType",
        "INVALID_OPTION",
        "The PIX key type is not supported.",
      );
    } else if (typeValue && !enabled.includes(typeValue as PixKeyType)) {
      addError(
        errors,
        "pixKeyType",
        "DISABLED_OPTION",
        "The PIX key type is disabled by the configured channel.",
      );
    } else if (
      typeValue &&
      key &&
      !isValidPixKey(typeValue as PixKeyType, key)
    ) {
      addError(
        errors,
        "pixKey",
        "INVALID_FORMAT",
        "The PIX key has an invalid basic format for the selected type.",
      );
    }
  } else if (methodId === "GB_LOCAL_ACCOUNT") {
    const sortCode = requiredString(input, "sortCode", errors);
    const account = requiredString(input, "accountNumber", errors);
    if (sortCode && !/^\d{6}$/.test(digitsOnly(sortCode)))
      addError(
        errors,
        "sortCode",
        "INVALID_FORMAT",
        "The sort code must contain six digits.",
      );
    if (account && !/^\d{8}$/.test(digitsOnly(account)))
      addError(
        errors,
        "accountNumber",
        "INVALID_FORMAT",
        "The UK account number must contain eight digits.",
      );
  } else if (methodId === "GB_IBAN") {
    const iban = requiredString(input, "iban", errors);
    if (iban && !isValidIban(iban, ["GB"]))
      addError(
        errors,
        "iban",
        "INVALID_IBAN",
        "The IBAN has an invalid country, length, or checksum for the United Kingdom route.",
      );
  }

  const safeOutputAllowlist = new Set<FieldId>(["accountType", "pixKeyType"]);
  const safeFields: SafeFieldOutput[] = method.fields
    .filter((field) => Object.prototype.hasOwnProperty.call(input, field.id))
    .map((field) => ({
      field: field.id,
      value:
        safeOutputAllowlist.has(field.id) && typeof input[field.id] === "string"
          ? (input[field.id] as string).trim().slice(0, 100)
          : "[REDACTED]",
    }));

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    safeFields: Object.freeze(safeFields),
  });
}
