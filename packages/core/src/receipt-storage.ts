/** Lossless at-rest compression; PDF bytes (including signatures) are never rewritten. */
export async function encodeReceipt(
  bytes: Uint8Array,
): Promise<{ data: Uint8Array; storageEncoding?: "gzip" }> {
  if (bytes.byteLength < 1024 || typeof CompressionStream === "undefined")
    return { data: bytes };
  const body = new Response(new Uint8Array(bytes)).body!.pipeThrough(
    new CompressionStream("gzip"),
  );
  const gzip = new Uint8Array(await new Response(body).arrayBuffer());
  return gzip.length < bytes.length * 0.95
    ? { data: gzip, storageEncoding: "gzip" }
    : { data: bytes };
}
export async function decodeReceipt(
  bytes: Uint8Array,
  encoding: "gzip" | undefined,
  expectedSize: number,
): Promise<Uint8Array> {
  if (!encoding) return bytes;
  const reader = new Response(new Uint8Array(bytes))
      .body!.pipeThrough(new DecompressionStream("gzip"))
      .getReader(),
    parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 2 * 1024 * 1024 || length > expectedSize)
        throw Error("Receipt size mismatch");
      parts.push(value);
    }
    if (length !== expectedSize) throw Error("Receipt size mismatch");
    const out = new Uint8Array(length);
    let pos = 0;
    for (const p of parts) {
      out.set(p, pos);
      pos += p.length;
    }
    return out;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
