import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// One .env at the repo root serves web, worker and scripts.
loadEnvConfig(path.resolve(import.meta.dirname, "../.."));

/** Applied to every response. The page Content-Security-Policy (nonce-based) is added with the UI. */
export const baseSecurityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

/** API responses are JSON or event streams, never documents: lock them down completely. */
export const apiSecurityHeaders = [
  { key: "Content-Security-Policy", value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The shared package ships TypeScript source.
  transpilePackages: ["@mssuzie/core"],
  async headers() {
    return [
      { source: "/:path*", headers: baseSecurityHeaders },
      { source: "/api/:path*", headers: apiSecurityHeaders },
    ];
  },
};

export default config;
