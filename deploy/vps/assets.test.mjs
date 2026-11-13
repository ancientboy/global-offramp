import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createAssetHandler } from "./assets.mjs";
test("only versioned public assets are cached; gzip, conditional requests and traversal are safe", async () => {
  const root = await mkdtemp(join(tmpdir(), "huitu-assets-"));
  try {
    await mkdir(join(root, "_next/static"), { recursive: true });
    const js = "let publicAsset=true;".repeat(500);
    await writeFile(join(root, "_next/static/a.js"), js);
    await writeFile(join(root, "workspace.html"), "<p>Login shell</p>");
    const serve = createAssetHandler(root),
      url = "https://bhcbtc.club/_next/static/a.js";
    const r = await serve(
      new Request(url, { headers: { "accept-encoding": "gzip" } }),
    );
    assert.match(r.headers.get("cache-control"), /public.*immutable/);
    assert.equal(r.headers.get("content-encoding"), "gzip");
    assert.equal(gunzipSync(Buffer.from(await r.arrayBuffer())).toString(), js);
    assert.equal(
      (
        await serve(
          new Request(url, {
            headers: { "if-none-match": r.headers.get("etag") },
          }),
        )
      ).status,
      304,
    );
    const raw = await serve(
      new Request(url, { headers: { "accept-encoding": "gzip;q=0" } }),
    );
    assert.equal(raw.headers.get("content-encoding"), null);
    assert.equal(await raw.text(), js);
    const head = await serve(
      new Request(url, {
        method: "HEAD",
        headers: { "accept-encoding": "gzip" },
      }),
    );
    assert.equal(await head.text(), "");
    assert.ok(Number(head.headers.get("content-length")) < js.length);
    const html = await serve(new Request("https://bhcbtc.club/workspace"));
    assert.match(html.headers.get("cache-control"), /private/);
    assert.equal(
      (await serve(new Request("https://bhcbtc.club/%2e%2e%2fsecret"))).status,
      403,
    );
    assert.equal(
      (await serve(new Request(url, { method: "POST" }))).status,
      405,
    );
    assert.equal(
      (await serve(new Request("https://bhcbtc.club/missing"))).status,
      404,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("self-hosted PDF workers are served as cacheable JavaScript modules", async () => {
  const root = await mkdtemp(join(tmpdir(), "huitu-pdf-assets-"));
  try {
    await mkdir(join(root, "vendor/pdfjs/v6.5.438"), { recursive: true });
    await writeFile(
      join(root, "vendor/pdfjs/v6.5.438/pdf.worker.min.mjs"),
      "export const worker=true;",
    );
    const r = await createAssetHandler(root)(
      new Request(
        "https://bhcbtc.club/vendor/pdfjs/v6.5.438/pdf.worker.min.mjs",
      ),
    );
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /javascript/);
    assert.match(r.headers.get("cache-control"), /public.*immutable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
