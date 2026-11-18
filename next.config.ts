import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),
  serverExternalPackages: ["unpdf", "@libsql/client", "libsql", "imapflow", "mailparser"],
};

export default nextConfig;
