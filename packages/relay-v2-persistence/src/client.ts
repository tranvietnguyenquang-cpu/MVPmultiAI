import { mkdir } from "node:fs/promises";
import { PrismaClient } from "../generated/client/index.js";
import { resolveRelayV2Paths, type RelayV2PathOptions, type RelayV2Paths } from "./paths.js";

export type RelayV2Database = PrismaClient;

export async function createRelayV2Client(options: RelayV2PathOptions = {}): Promise<{ client: PrismaClient; paths: RelayV2Paths }> {
  const paths = resolveRelayV2Paths(options);
  await mkdir(paths.artifactsDir, { recursive: true });
  const client = new PrismaClient({ datasourceUrl: paths.databaseUrl });
  await client.$connect();
  await client.$queryRawUnsafe("PRAGMA foreign_keys = ON");
  await client.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await client.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  return { client, paths };
}

const globalRelayV2 = globalThis as unknown as { relayV2Database?: Promise<{ client: PrismaClient; paths: RelayV2Paths }> };

export function getRelayV2Database(): Promise<{ client: PrismaClient; paths: RelayV2Paths }> {
  globalRelayV2.relayV2Database ??= createRelayV2Client();
  return globalRelayV2.relayV2Database;
}
