import{describe,expect,it,vi}from"vitest";import{pollCancellation}from"./cancellation.js";
describe("cross-process cancellation polling",()=>{it("aborts when persistent state changes",async()=>{const abort=vi.fn();let checks=0;await pollCancellation({isCancelled:async()=>++checks>1,abort,intervalMs:1});expect(abort).toHaveBeenCalledOnce();});});
