import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// One .env at the repo root serves web, worker and scripts.
loadEnvConfig(path.resolve(import.meta.dirname, "../.."));

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // The shared package ships TypeScript source.
  transpilePackages: ["@mssuzie/core"],
};

export default config;
