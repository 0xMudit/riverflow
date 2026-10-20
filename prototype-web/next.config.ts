import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The ledger is written to disk from route handlers; keep node built-ins intact.
  serverExternalPackages: [],
};

export default nextConfig;
