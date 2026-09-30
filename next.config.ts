import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // 每次发布生成新的构建标识，避免浏览器继续使用旧的 Agent 前端 chunk。
  generateBuildId: async () => `infinite-${Date.now().toString(36)}`,
  serverExternalPackages: ["better-sqlite3", "@volcengine/tos-sdk", "node-edge-tts"],
};

export default nextConfig;
