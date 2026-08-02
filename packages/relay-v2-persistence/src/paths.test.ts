import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveRelayV2Paths } from "./paths.js";

describe("Relay v2 data path resolution", () => {
  it.runIf(process.platform === "win32")("uses LOCALAPPDATA\\Relay for a normal Windows production-local install", () => {
    const result = resolveRelayV2Paths({ environment: "production", localAppData: "C:\\Users\\relay\\AppData\\Local", testMode: false });
    expect(result.dataDir).toBe(path.join("C:\\Users\\relay\\AppData\\Local", "Relay"));
    expect(result.databaseUrl).toBe("file:C:/Users/relay/AppData/Local/Relay/relay-v2.db");
  });

  it("uses the ignored repository-local directory in development", () => {
    const result = resolveRelayV2Paths({ environment: "development", cwd: process.cwd(), testMode: false });
    expect(result.dataDir).toBe(path.join(process.cwd(), ".relay-data"));
  });

  it("fails closed in test mode without an explicit disposable directory", () => {
    expect(() => resolveRelayV2Paths({ testMode: true })).toThrow(/required in automated tests/i);
  });
});
