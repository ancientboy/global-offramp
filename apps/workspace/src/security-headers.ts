import { createHash } from "node:crypto";
export function workspaceHeaders(html?: Buffer) {
  const hashes = html
    ? Array.from(
        html.toString("utf8").matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi),
      )
        .filter((m) => m[1].length > 0)
        .map(
          (m) =>
            "'sha256-" +
            createHash("sha256").update(m[1]).digest("base64") +
            "'",
        )
    : [];
  return {
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
    "strict-transport-security": "max-age=31536000",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    ...(html
      ? {
          "content-security-policy": [
            "default-src 'self'",
            ["script-src 'self' 'wasm-unsafe-eval'", ...hashes].join(" "),
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self'",
            "connect-src 'self' blob:",
            "worker-src 'self' blob:",
            "frame-src 'self' blob:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
          ].join("; "),
        }
      : {}),
  };
}
