import { describe, expect, it } from "vitest";
import { assertDisposableDatabaseUrl, assertDisposableRedisUrl, isDisposableDatabaseName } from "./index.js";

describe("isDisposableDatabaseName", () => {
  it("accepts names matching the disposable allowlist", () => {
    expect(isDisposableDatabaseName("projectrelay_test_verification")).toBe(true);
    expect(isDisposableDatabaseName("projectrelay_test_unit")).toBe(true);
    expect(isDisposableDatabaseName("projectrelay_validation_run1")).toBe(true);
    expect(isDisposableDatabaseName("projectrelay_e2e_browser")).toBe(true);
  });

  it("refuses the normal local-beta database name", () => {
    expect(isDisposableDatabaseName("projectrelay")).toBe(false);
  });

  it("refuses an unrelated project's database name", () => {
    expect(isDisposableDatabaseName("webmanageschool")).toBe(false);
    expect(isDisposableDatabaseName("WebManageSchool")).toBe(false);
  });

  it("refuses any database not explicitly marked disposable", () => {
    expect(isDisposableDatabaseName("postgres")).toBe(false);
    expect(isDisposableDatabaseName("tenant_orange_english")).toBe(false);
    expect(isDisposableDatabaseName("projectrelay_prod")).toBe(false);
    expect(isDisposableDatabaseName("")).toBe(false);
  });
});

describe("assertDisposableDatabaseUrl", () => {
  it("accepts a loopback URL naming a disposable database", () => {
    expect(() => assertDisposableDatabaseUrl("postgresql://user:pass@127.0.0.1:55432/projectrelay_test_verification?schema=public")).not.toThrow();
    expect(() => assertDisposableDatabaseUrl("postgresql://user:pass@localhost:55432/projectrelay_e2e_browser")).not.toThrow();
  });

  it("refuses the normal local-beta database even on the disposable-looking host/port", () => {
    expect(() => assertDisposableDatabaseUrl("postgresql://projectrelay:projectrelay@127.0.0.1:5434/projectrelay?schema=public")).toThrow(/disposable/);
  });

  it("refuses an unrelated project's database (WebManageSchool)", () => {
    expect(() => assertDisposableDatabaseUrl("postgresql://postgres:postgres@127.0.0.1:5433/webmanageschool")).toThrow(/disposable/);
  });

  it("refuses a non-loopback host even if the database name looks disposable", () => {
    expect(() => assertDisposableDatabaseUrl("postgresql://user:pass@203.0.113.5:5432/projectrelay_test_verification")).toThrow(/loopback/);
  });

  it("refuses a missing or unparsable URL", () => {
    expect(() => assertDisposableDatabaseUrl(undefined)).toThrow();
    expect(() => assertDisposableDatabaseUrl("not-a-url")).toThrow();
  });
});

describe("assertDisposableRedisUrl", () => {
  it("accepts the dedicated disposable test Redis port", () => {
    expect(() => assertDisposableRedisUrl("redis://127.0.0.1:56379")).not.toThrow();
  });

  it("refuses the local-beta Redis port", () => {
    expect(() => assertDisposableRedisUrl("redis://127.0.0.1:6380")).toThrow(/56379/);
  });

  it("refuses an unrelated project's Redis (default port, e.g. WebManageSchool)", () => {
    expect(() => assertDisposableRedisUrl("redis://127.0.0.1:6379")).toThrow(/56379/);
  });

  it("refuses a non-loopback host", () => {
    expect(() => assertDisposableRedisUrl("redis://203.0.113.5:56379")).toThrow(/loopback/);
  });
});
