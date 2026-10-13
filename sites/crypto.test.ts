import assert from "node:assert/strict";
import * as native from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { Buffer } from "buffer";
import { build } from "esbuild";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "./crypto";
import { Buffer as InjectedBuffer } from "./globals";

test("SHA-256 hex matches native crypto for empty, ASCII, Unicode and long input", () => {
  for (const value of ["", "abc", "汇途 · MOCK 🔒", "a".repeat(100_000)]) {
    assert.equal(
      createHash("sha256").update(value).digest("hex"),
      native.createHash("sha256").update(value).digest("hex"),
    );
  }
});

test("SHA-256 buffer digest and chained mixed updates match native crypto", () => {
  const bytes = Buffer.from([0, 1, 127, 128, 255]);
  const hash = createHash("sha256");
  assert.equal(hash.update("prefix."), hash);
  const result = hash.update(bytes).update("后缀").digest();
  const expected = native
    .createHash("sha256")
    .update("prefix.")
    .update(bytes)
    .update("后缀")
    .digest();
  assert.ok(Buffer.isBuffer(result));
  assert.equal(result.length, 32);
  assert.deepEqual(result, expected);
});

test("SHA-256 respects input encodings and byte-view offsets", () => {
  const buffer = Uint8Array.from([10, 20, 30, 40, 50, 60]);
  const values = [
    buffer.subarray(1, 4),
    new DataView(buffer.buffer, 2, 3),
    new Uint16Array(buffer.buffer, 2, 2),
  ];
  for (const value of values) {
    assert.equal(
      createHash("sha256").update(value).digest("hex"),
      native.createHash("sha256").update(value).digest("hex"),
    );
  }
  for (const encoding of ["hex", "base64", "latin1"] as const) {
    const text = encoding === "hex" ? "deadbeef" : "YWJj";
    assert.equal(
      createHash("sha256").update(text, encoding).digest("hex"),
      native.createHash("sha256").update(text, encoding).digest("hex"),
    );
  }
});

test("HMAC-SHA-256 matches native crypto across string and binary keys", () => {
  const source = Uint8Array.from([0, 10, 20, 30, 255]);
  const keys = [
    "",
    "mock-webhook-secret-32-characters-minimum",
    "密钥🔒",
    "x".repeat(200),
    Buffer.from([0, 128, 255]),
    source.subarray(1, 4),
    new DataView(source.buffer, 2, 2),
    source.buffer,
  ];
  for (const key of keys) {
    assert.equal(
      createHmac("sha256", key).update("payload").digest("hex"),
      native
        .createHmac(
          "sha256",
          key instanceof ArrayBuffer ? Buffer.from(key) : key,
        )
        .update("payload")
        .digest("hex"),
    );
  }
});

test("webhook HMAC chained timestamp/raw Buffer updates match native crypto", () => {
  const secret = "mock-webhook-secret-at-least-32-characters";
  const timestamp = "1791878400";
  const raw = Buffer.from('{"eventId":"MOCK-1","description":"模拟入金"}');
  const mac = createHmac("sha256", secret);
  assert.equal(mac.update(timestamp + "."), mac);
  const result = mac.update(raw).digest();
  const expected = native
    .createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(raw)
    .digest();
  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual(result, expected);
  assert.equal(timingSafeEqual(result, expected), true);
});

test("empty SHA-256 and HMAC messages match native without any updates", () => {
  assert.deepEqual(
    createHash("sha256").digest(),
    native.createHash("sha256").digest(),
  );
  assert.deepEqual(
    createHmac("sha256", "secret").digest(),
    native.createHmac("sha256", "secret").digest(),
  );
});

test("finalized hash and HMAC behavior matches the supported native operations", () => {
  const hash = createHash("sha256").update("message");
  const nativeHash = native.createHash("sha256").update("message");
  assert.deepEqual(hash.digest(), nativeHash.digest());
  assert.throws(() => hash.update("more"));
  assert.throws(() => nativeHash.update("more"));
  assert.throws(() => hash.digest());
  assert.throws(() => nativeHash.digest());
  const mac = createHmac("sha256", "secret").update("message");
  const nativeMac = native.createHmac("sha256", "secret").update("message");
  assert.deepEqual(mac.digest(), nativeMac.digest());
  assert.deepEqual(mac.digest(), nativeMac.digest());
  assert.equal(mac.digest("hex"), nativeMac.digest("hex"));
  assert.throws(() => mac.update("more"));
  assert.throws(() => nativeMac.update("more"));
});

test("unsupported algorithms and digest encodings fail explicitly", () => {
  assert.throws(() => createHash("sha512"), /only sha256/);
  assert.throws(() => createHmac("sha1", "secret"), /only sha256/);
  assert.throws(
    () => createHash("sha256").digest("base64" as "hex"),
    /only hex/,
  );
});

test("timingSafeEqual matches native for all single-byte values and differences", () => {
  for (let value = 0; value < 256; value++) {
    const left = Buffer.from([value, 17, 29]);
    for (let position = 0; position < left.length; position++) {
      const right = Buffer.from(left);
      assert.equal(
        timingSafeEqual(left, right),
        native.timingSafeEqual(left, right),
      );
      right[position] ^= 1;
      assert.equal(
        timingSafeEqual(left, right),
        native.timingSafeEqual(left, right),
      );
    }
  }
  assert.equal(timingSafeEqual(Buffer.alloc(0), Buffer.alloc(0)), true);
});

test("timingSafeEqual respects byte offsets, typed views and raw ArrayBuffers", () => {
  const bytes = Uint8Array.from([99, 1, 2, 3, 4, 88]);
  const expected = Uint8Array.from([1, 2, 3, 4]);
  for (const value of [
    bytes.subarray(1, 5),
    new DataView(bytes.buffer, 1, 4),
    new Uint16Array(expected.buffer),
    expected.buffer,
  ]) {
    assert.equal(
      timingSafeEqual(value, expected),
      native.timingSafeEqual(
        value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        expected,
      ),
    );
  }
});

test("timingSafeEqual length mismatch throws the native error code", () => {
  const left = Buffer.from([1]);
  const right = Buffer.from([1, 2]);
  const expected = {
    name: "RangeError",
    code: "ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH",
  };
  assert.throws(() => timingSafeEqual(left, right), expected);
  assert.throws(() => native.timingSafeEqual(left, right), expected);
});

test("randomUUID delegates to WebCrypto and returns unique version-4 UUIDs", () => {
  const original = globalThis.crypto;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  let calls = 0;
  const cryptoProxy = {
    randomUUID() {
      calls++;
      return original.randomUUID();
    },
  };
  try {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: cryptoProxy,
    });
    const ids = Array.from({ length: 128 }, () => randomUUID());
    assert.equal(calls, ids.length);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.match(
        id,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "crypto", descriptor);
  }
});

test("globals exports Buffer for injection without replacing the global binding", () => {
  assert.equal(InjectedBuffer, Buffer);
  assert.equal(globalThis.Buffer, Buffer);
  assert.equal(InjectedBuffer.from("MOCK").toString("hex"), "4d4f434b");
});

test("browser bundle verifies a native-signed webhook without Node globals", async () => {
  const secret = "mock-only-native-webhook-test-secret-32-characters";
  const timestamp = "1791878400";
  const payload = '{"eventId":"MOCK-browser","description":"模拟"}';
  const signature = native
    .createHmac("sha256", secret)
    .update(timestamp + ".")
    .update(Buffer.from(payload))
    .digest("hex");
  const bundle = await build({
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "es2022",
    write: false,
    alias: { "node:crypto": resolve(__dirname, "crypto.ts") },
    inject: [resolve(__dirname, "globals.ts")],
    stdin: {
      resolveDir: __dirname,
      loader: "ts",
      contents: `
        import { createHash, randomUUID } from "node:crypto";
        import { signWebhook, verifyWebhook } from "../packages/core/src/security";
        const raw = Buffer.from(${JSON.stringify(payload)});
        verifyWebhook(raw, ${JSON.stringify(timestamp)}, ${JSON.stringify(signature)},
          ${JSON.stringify(secret)}, new Date(Number(${JSON.stringify(timestamp)}) * 1000));
        globalThis.result = {
          signature: signWebhook(raw, ${JSON.stringify(timestamp)}, ${JSON.stringify(secret)}),
          hash: createHash("sha256").update(raw).digest("hex"),
          buffer: Buffer.isBuffer(createHash("sha256").update(raw).digest()),
          uuid: randomUUID(),
        };
      `,
    },
  });
  const sandbox = {
    crypto: native.webcrypto,
    Buffer: undefined,
    result: undefined as unknown,
  };
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  const result = sandbox.result as {
    signature: string;
    hash: string;
    buffer: boolean;
    uuid: string;
  };
  assert.equal(result.signature, signature);
  assert.equal(
    result.hash,
    native.createHash("sha256").update(payload).digest("hex"),
  );
  assert.equal(result.buffer, true);
  assert.match(result.uuid, /^[0-9a-f-]{36}$/);
  assert.equal(sandbox.Buffer, undefined);
});
