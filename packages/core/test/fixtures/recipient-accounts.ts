import type { FullRecipientInput } from "../../src/recipient-account";
export const examples: FullRecipientInput[] = [
  {
    country: "CN",
    currency: "CNY",
    method: "CN_BANK_ACCOUNT",
    fields: {
      accountHolderName: "测试收款人",
      bankName: "测试银行",
      accountNumber: "6222021000001234567",
      branchName: "测试支行",
      province: "广东省",
      city: "深圳市",
    },
  },
  {
    country: "US",
    currency: "USD",
    method: "US_BANK_ACCOUNT",
    fields: {
      accountHolderName: "Example Recipient",
      bankName: "Example Bank",
      abaRoutingNumber: "021000021",
      accountNumber: "000123456789",
      accountType: "checking",
      addressLine1: "123 Example Street",
      city: "New York",
      state: "NY",
      postalCode: "10001",
    },
  },
  {
    country: "DE",
    currency: "EUR",
    method: "EUR_IBAN",
    fields: {
      accountHolderName: "Example Recipient",
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
    },
  },
  {
    country: "MX",
    currency: "MXN",
    method: "MX_CLABE",
    fields: {
      accountHolderName: "Example Recipient",
      clabe: "032180000118359719",
    },
  },
  {
    country: "BR",
    currency: "BRL",
    method: "BR_BANK_ACCOUNT",
    fields: {
      accountHolderName: "Example Recipient",
      bankName: "Example Bank",
      bankCode: "001",
      branchNumber: "1234-0",
      accountNumber: "12345-6",
      accountType: "checking",
      taxId: "529.982.247-25",
    },
  },
  {
    country: "BR",
    currency: "BRL",
    method: "BR_PIX",
    fields: {
      accountHolderName: "Example Recipient",
      pixKeyType: "email",
      pixKey: "test@example.com",
    },
  },
  {
    country: "GB",
    currency: "GBP",
    method: "GB_LOCAL_ACCOUNT",
    fields: {
      accountHolderName: "Example Recipient",
      sortCode: "12-34-56",
      accountNumber: "00123456",
    },
  },
  {
    country: "GB",
    currency: "GBP",
    method: "GB_IBAN",
    fields: {
      accountHolderName: "Example Recipient",
      iban: "GB82WEST12345698765432",
    },
  },
];
