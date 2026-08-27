import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["better-sqlite3", "@volcengine/tos-sdk", "node-edge-tts"],
};

export default nextConfig;
