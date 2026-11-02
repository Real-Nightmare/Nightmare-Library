import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native addons must not enter the webpack bundle — the binary trips
  // module parsing. Load them at runtime instead (they fail gracefully).
  serverExternalPackages: ["@libsql/client", "@siafoundation/sia-storage"],
};

export default nextConfig;
