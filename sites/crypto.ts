import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { Buffer } from "buffer";

// Synchronous node:crypto subset used by the private MOCK Worker bundle.
// This is intentionally not a general-purpose Node crypto replacement.
type Bytes = ArrayBuffer | ArrayBufferView;
type Input = string | ArrayBufferView;
type HashState = {
  update(bytes: Uint8Array): unknown;
  digest(): Uint8Array;
};

function byteView(value: Bytes): Uint8Array {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("Expected an ArrayBuffer or ArrayBuffer view");
}

function inputBytes(value: Input, encoding: BufferEncoding = "utf8") {
  if (typeof value === "string") return Buffer.from(value, encoding);
  if (!ArrayBuffer.isView(value)) {
    throw new TypeError("Expected a string or ArrayBuffer view");
  }
  return byteView(value);
}

function requireSha256(algorithm: string): void {
  if (typeof algorithm !== "string" || algorithm.toLowerCase() !== "sha256") {
    throw new TypeError("The MOCK Worker crypto adapter supports only sha256");
  }
}

class Digest {
  private finalized = false;

  constructor(
    private readonly state: HashState,
    private readonly isHmac = false,
  ) {}

  update(value: Input, encoding?: BufferEncoding): this {
    if (this.finalized) throw new Error("Digest already called");
    this.state.update(inputBytes(value, encoding));
    return this;
  }

  digest(): Buffer;
  digest(encoding: "hex"): string;
  digest(encoding?: "hex"): Buffer | string {
    if (encoding !== undefined && encoding !== "hex") {
      throw new TypeError("The MOCK Worker crypto adapter supports only hex");
    }
    if (this.finalized && !this.isHmac)
      throw new Error("Digest already called");
    // Node's Hmac returns an empty digest when read again; Hash throws instead.
    const result = this.finalized
      ? Buffer.alloc(0)
      : Buffer.from(this.state.digest());
    this.finalized = true;
    return encoding === "hex" ? result.toString("hex") : result;
  }
}

export function createHash(algorithm: string): Digest {
  requireSha256(algorithm);
  return new Digest(sha256.create());
}

export function createHmac(algorithm: string, secret: string | Bytes): Digest {
  requireSha256(algorithm);
  const key =
    typeof secret === "string" ? Buffer.from(secret) : byteView(secret);
  return new Digest(hmac.create(sha256, key), true);
}

export function randomUUID(): `${string}-${string}-${string}-${string}-${string}` {
  return globalThis.crypto.randomUUID();
}

export function timingSafeEqual(left: Bytes, right: Bytes): boolean {
  const a = byteView(left);
  const b = byteView(right);
  if (a.byteLength !== b.byteLength) {
    throw Object.assign(
      new RangeError("Input buffers must have the same byte length"),
      { code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH" },
    );
  }
  // Visit every byte without data-dependent early returns. JavaScript engines
  // cannot guarantee native constant-time execution; this adapter is MOCK-only.
  let difference = 0;
  for (let index = 0; index < a.byteLength; index++) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}
