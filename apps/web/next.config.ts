import type { NextConfig } from "next";
import path from "node:path";

const workspaceRoot = path.resolve(__dirname, "../..");
const config: NextConfig = {
  transpilePackages: ["@project-relay/database","@project-relay/shared","@project-relay/execution","@project-relay/local-safety","@project-relay/project-memory","@project-relay/providers","@project-relay/context-engine","@project-relay/relay-v2-domain","@project-relay/relay-v2-persistence","@project-relay/relay-v2-orchestrator","@project-relay/relay-v2-execution"],
  turbopack: { root: workspaceRoot },
  experimental: { serverActions: { bodySizeLimit: "2mb" } }
};
export default config;
