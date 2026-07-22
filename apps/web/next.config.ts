import type { NextConfig } from "next";
const config: NextConfig = { transpilePackages: ["@project-relay/database","@project-relay/shared","@project-relay/execution","@project-relay/project-memory","@project-relay/providers","@project-relay/context-engine"], experimental: { serverActions: { bodySizeLimit: "2mb" } } };
export default config;
