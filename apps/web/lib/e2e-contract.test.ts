import { describe, expect, it } from "vitest";
import { validateMutationRequest } from "./csrf.js";

describe("e2e browser request contract",()=>{
  it("e2e accepts a same-origin mutation only with the matching CSRF token",()=>{
    expect(validateMutationRequest({method:"POST",requestOrigin:"http://127.0.0.1:3300",serverOrigin:"http://127.0.0.1:3300",cookieToken:"test-token",headerToken:"test-token"})).toBe(true);
    expect(validateMutationRequest({method:"POST",requestOrigin:"http://evil.invalid",serverOrigin:"http://127.0.0.1:3300",cookieToken:"test-token",headerToken:"test-token"})).toBe(false);
  });
});
