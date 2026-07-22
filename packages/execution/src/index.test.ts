import { describe,expect,it } from "vitest"; import { redactSecrets,resolveInsideWorkspace } from "./index.js";
describe("secret redaction",()=>{it("removes common credentials and URLs",()=>{const output=redactSecrets("token=abc123 password=hunter2 postgresql://user:pass@host/db");expect(output).not.toContain("abc123");expect(output).not.toContain("hunter2");expect(output).not.toContain("user:pass");});});
describe("path containment",()=>{it("rejects traversal",async()=>{await expect(resolveInsideWorkspace(process.cwd(),"../outside.txt")).rejects.toThrow(/escapes/);});});
