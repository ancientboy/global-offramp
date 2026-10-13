import { demand } from "./money";
/** Providers are ports only. No real credential, transfer or trade code exists. */
export interface CustodyProvider {
  mode: "mock";
  allocateDepositReference(
    orderId: string,
  ): Promise<{ reference: string; network: "MOCK"; address: null }>;
  poll(
    after: string | undefined,
  ): Promise<{ events: unknown[]; cursor: string }>;
}
export class MockCustodyProvider implements CustodyProvider {
  mode = "mock" as const;
  async allocateDepositReference(orderId: string) {
    return {
      reference: "MOCK-" + orderId,
      network: "MOCK" as const,
      address: null,
    };
  }
  async poll(after: string | undefined) {
    return { events: [], cursor: after ?? "mock-start" };
  }
}
export interface PrivateObjectStorage {
  presignUpload(input: {
    objectKey: string;
    contentType: "application/pdf" | "image/png" | "image/jpeg";
    size: number;
    sha256: string;
  }): Promise<{
    url: string;
    expiresAt: string;
    requiredHeaders: Record<string, string>;
  }>;
  presignDownload(
    objectKey: string,
  ): Promise<{ url: string; expiresAt: string }>;
  verifyObject(objectKey: string): Promise<{
    sha256: string;
    size: number;
    scanStatus: "clean" | "pending" | "rejected";
  }>;
}
/** Fail closed: deployment must inject a private-bucket implementation with AV and ownership checks. */
export class UnconfiguredPrivateStorage implements PrivateObjectStorage {
  async presignUpload(): Promise<never> {
    throw new Error("PRIVATE_STORAGE_NOT_CONFIGURED");
  }
  async presignDownload(): Promise<never> {
    throw new Error("PRIVATE_STORAGE_NOT_CONFIGURED");
  }
  async verifyObject(): Promise<never> {
    throw new Error("PRIVATE_STORAGE_NOT_CONFIGURED");
  }
}
export class MockManualPayoutProvider {
  readonly mode = "mock";
  async execute(): Promise<never> {
    throw new Error(
      "REAL_EXECUTION_DISABLED: record independently verified external operations only",
    );
  }
}
export function validateReceiptMetadata(input: {
  objectKey: string;
  contentType: string;
  size: number;
  sha256: string;
}) {
  demand(
    /^receipts\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.(pdf|png|jpg)$/.test(
      input.objectKey,
    ),
    "INVALID_OBJECT_KEY",
    "Invalid private receipt key",
  );
  demand(
    ["application/pdf", "image/png", "image/jpeg"].includes(
      input.contentType,
    ) &&
      input.size > 0 &&
      input.size <= 10 * 1024 * 1024,
    "INVALID_FILE",
    "Allowed file types PDF, PNG, JPEG up to 10MB",
  );
  demand(
    /^[a-f0-9]{64}$/.test(input.sha256),
    "INVALID_CHECKSUM",
    "SHA-256 required",
  );
}
export interface VerifiedIdentity {
  subject: string;
  issuer: string;
  audience: string;
  expiresAt: string;
  authenticationMethods: string[];
  sessionId: string;
}
export interface IdentityProvider {
  verifyAccessToken(token: string): Promise<VerifiedIdentity>;
}
export class UnconfiguredIdentityProvider implements IdentityProvider {
  async verifyAccessToken(): Promise<never> {
    throw new Error("PRODUCTION_AUTH_REQUIRED");
  }
}
export interface ExternalConversionRecord {
  providerReference: string;
  orderId: string;
  sourceCurrency: "USDT" | "USDC";
  sourceAmount: string;
  payoutCurrency: "CNY" | "USD";
  allocatedPayoutAmount: string;
  actualRate: string;
  effectiveAt: string;
  evidenceObjectKey: string;
}
export interface ProviderStatementRow {
  providerReference: string;
  currency: "CNY" | "USD";
  amount: string;
  status: "sent" | "failed" | "unknown";
  effectiveAt: string;
}
export interface ReconciliationProvider {
  fetchStatement(
    fromInclusive: string,
    toExclusive: string,
  ): Promise<ProviderStatementRow[]>;
}
