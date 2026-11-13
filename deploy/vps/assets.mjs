import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
  ".woff2": "font/woff2",
};
export const isPublicAsset = (path) =>
  path.startsWith("/_next/static/") ||
  /^\/vendor\/pdfjs\/v\d+\.\d+\.\d+\//.test(path) ||
  /^\/brand\/[a-zA-Z0-9_-]+-v\d+\.(png|webp|svg|ico)$/.test(path);
export function createAssetHandler(root) {
  const assets = resolve(root),
    cache = new Map();
  let cacheBytes = 0;
  return async function asset(request) {
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, { status: 405 });
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response(null, { status: 400 });
    }
    const path = resolve(assets, "." + pathname);
    if (path !== assets && !path.startsWith(assets + sep))
      return new Response(null, { status: 403 });
    for (const candidate of [
      path,
      path + ".html",
      resolve(path, "index.html"),
    ]) {
      let info;
      try {
        info = await stat(candidate);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;
      let entry = cache.get(candidate);
      if (!entry || entry.mtime !== info.mtimeMs || entry.size !== info.size) {
        const body = await readFile(candidate),
          type = mime[extname(candidate)] || "application/octet-stream";
        const gzip =
          body.length > 1024 &&
          /^(text\/|application\/(json|wasm)|image\/svg)/.test(type)
            ? gzipSync(body)
            : null;
        entry = {
          mtime: info.mtimeMs,
          size: info.size,
          body,
          gzip,
          type,
          etag: 'W/"' + createHash("sha256").update(body).digest("hex") + '"',
        };
        // Keep memory bounded; files remain available from disk after eviction.
        if (cache.has(candidate)) {
          const old = cache.get(candidate);
          cacheBytes -= old.body.length + (old.gzip?.length ?? 0);
          cache.delete(candidate);
        }
        cacheBytes += body.length + (gzip?.length ?? 0);
        cache.set(candidate, entry);
        while (cache.size > 128 || cacheBytes > 32 * 1024 * 1024) {
          const key = cache.keys().next().value,
            old = cache.get(key);
          cacheBytes -= old.body.length + (old.gzip?.length ?? 0);
          cache.delete(key);
        }
      }
      const headers = new Headers({
        "content-type": entry.type,
        "cache-control": isPublicAsset(pathname)
          ? "public, max-age=31536000, immutable"
          : "private, no-cache",
        etag: entry.etag,
        vary: "Accept-Encoding",
        "x-content-type-options": "nosniff",
      });
      const enc = (request.headers.get("accept-encoding") || "")
        .split(",")
        .map((x) => x.trim());
      const compressed =
        entry.gzip &&
        enc.some(
          (x) =>
            /^gzip(?:;|$)/i.test(x) && !/^gzip\s*;\s*q=0(?:\.0*)?$/i.test(x),
        );
      const body = compressed ? entry.gzip : entry.body;
      if (compressed) headers.set("content-encoding", "gzip");
      if (
        (request.headers.get("if-none-match") || "")
          .split(",")
          .map((x) => x.trim())
          .some((x) => x === entry.etag || x === "*")
      )
        return new Response(null, { status: 304, headers });
      headers.set("content-length", String(body.length));
      return new Response(request.method === "HEAD" ? null : body, { headers });
    }
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  };
}
