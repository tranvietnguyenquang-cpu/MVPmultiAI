import { describe, expect, it } from "vitest";
import { buildSafeEnvironment, safeEnvironmentKeyNames } from "./environment-policy.js";

describe("Codex environment policy", () => {
  it("preserves required operating-system values and excludes secrets", () => {
    const environment = buildSafeEnvironment({
      PATH: "safe-path", USERPROFILE: "profile", TEMP: "temp", CODEX_HOME: "codex-home",
      OPENAI_API_KEY: "secret", DATABASE_URL: "secret-db", GITHUB_TOKEN: "secret-token",
      RELAY_INTERNAL_VALUE: "unrelated"
    });
    expect(environment).toMatchObject({ PATH: "safe-path", USERPROFILE: "profile", TEMP: "temp", CODEX_HOME: "codex-home", NO_COLOR: "1" });
    expect(JSON.stringify(environment)).not.toContain("secret");
    expect(safeEnvironmentKeyNames(environment)).not.toEqual(expect.arrayContaining(["OPENAI_API_KEY", "DATABASE_URL", "GITHUB_TOKEN", "RELAY_INTERNAL_VALUE"]));
  });
});
