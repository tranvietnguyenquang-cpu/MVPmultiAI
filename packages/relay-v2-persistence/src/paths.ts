import { existsSync } from "node:fs";
import path from "node:path";

export type RelayV2PathOptions = {
  dataDir?: string;
  environment?: string;
  cwd?: string;
  localAppData?: string;
  testMode?: boolean;
};

export type RelayV2Paths = {
  dataDir: string;
  databasePath: string;
  databaseUrl: string;
  artifactsDir: string;
};

function findRepositoryRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, "package.json")) && existsSync(path.join(current, "apps")) && existsSync(path.join(current, "packages"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Could not locate the Relay repository root for the development data directory.");
    current = parent;
  }
}

export function toPrismaSqliteUrl(databasePath: string): string {
  return `file:${path.resolve(databasePath).replace(/\\/g, "/")}`;
}

export function resolveRelayV2Paths(options: RelayV2PathOptions = {}): RelayV2Paths {
  const environment = options.environment ?? process.env.NODE_ENV ?? "development";
  const testMode = options.testMode ?? (process.env.VITEST === "true" || process.env.PROJECT_RELAY_TEST_MODE === "true");
  const explicit = options.dataDir ?? process.env.RELAY_V2_DATA_DIR;
  let dataDir: string;

  if (testMode) {
    if (!explicit) throw new Error("RELAY_V2_DATA_DIR is required in automated tests and must point to a disposable directory.");
    dataDir = path.resolve(explicit);
  } else if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error("RELAY_V2_DATA_DIR must be an absolute path.");
    dataDir = path.resolve(explicit);
  } else if (environment === "production") {
    const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
    if (!localAppData || !path.isAbsolute(localAppData)) throw new Error("LOCALAPPDATA is required for Relay v2 production-local storage on Windows.");
    dataDir = path.join(localAppData, "Relay");
  } else {
    dataDir = path.join(findRepositoryRoot(options.cwd ?? process.cwd()), ".relay-data");
  }

  const databasePath = path.join(dataDir, "relay-v2.db");
  return {
    dataDir,
    databasePath,
    databaseUrl: toPrismaSqliteUrl(databasePath),
    artifactsDir: path.join(dataDir, "artifacts")
  };
}
