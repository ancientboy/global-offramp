import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { FullRecipientInput } from "../../../packages/core/src/recipient-account";
export class RecipientVault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw Error("Recipient key must contain 32 bytes");
  }
  private aad(
    scope: {
      customerId: string;
      country: string;
      currency: string;
      accountToken: string;
    },
    method: string,
  ) {
    return Buffer.from(
      JSON.stringify([
        scope.customerId,
        scope.country,
        scope.currency,
        scope.accountToken,
        method,
      ]),
    );
  }
  seal(
    scope: {
      customerId: string;
      country: string;
      currency: string;
      accountToken: string;
    },
    input: FullRecipientInput,
  ) {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key, iv);
    c.setAAD(this.aad(scope, input.method));
    const ciphertext = Buffer.concat([
      c.update(JSON.stringify(input.fields), "utf8"),
      c.final(),
    ]);
    return [
      "v1",
      iv.toString("base64url"),
      c.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }
  open(scope: {
    customerId: string;
    country: string;
    currency: string;
    accountToken: string;
    recipientAccount?: { method: string; encrypted: string };
  }): Record<string, string> {
    if (!scope.recipientAccount) throw Error("Recipient details missing");
    const [version, nonce, tag, ciphertext] =
      scope.recipientAccount.encrypted.split(".");
    if (version !== "v1" || !nonce || !tag || !ciphertext)
      throw Error("Recipient details unavailable");
    const d = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(nonce, "base64url"),
    );
    d.setAAD(this.aad(scope, scope.recipientAccount.method));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(
      Buffer.concat([
        d.update(Buffer.from(ciphertext, "base64url")),
        d.final(),
      ]).toString("utf8"),
    );
  }
}
