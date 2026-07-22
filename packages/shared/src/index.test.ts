import { describe,expect,it } from "vitest"; import { approximateTokens,canVerify } from "./index.js";
describe("verification gate",()=>{it("requires successful evidence for every criterion",()=>{expect(canVerify([{evidence:[{successful:true}]},{evidence:[]}])).toBe(false);expect(canVerify([{evidence:[{successful:true}]},{evidence:[{successful:true}]}])).toBe(true);expect(canVerify([])).toBe(false);});});
describe("token estimate",()=>{it("returns a conservative non-zero approximation",()=>{expect(approximateTokens({hello:"world"})).toBeGreaterThan(0);});});
