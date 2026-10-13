import type { NextConfig } from "next";

// Sites serves the exported static client and /api through its isolated MOCK worker.
// Normal Node development/hosting keeps the NestJS API proxy.
const siteExport = process.env.SITE_EXPORT === "true";
const config: NextConfig = {
  poweredByHeader: false,
  ...(siteExport
    ? { output: "export" as const }
    : {
        async rewrites() {
          return [
            {
              source: "/api/:path*",
              destination:
                (process.env.API_INTERNAL_URL ?? "http://127.0.0.1:3001") +
                "/api/:path*",
            },
          ];
        },
      }),
};
export default config;
