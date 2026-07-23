import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { captureOwnedProcess, terminateOwnedProcessTree } from "./owned-process.js";

const sleeper="setInterval(()=>{},1000)";
describe("owned Windows provider process trees",()=>{
  it("terminates only the recorded root tree and leaves an unrelated sibling alive",async()=>{
    const root=spawn(process.execPath,["-e",`const{spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(`const{spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(sleeper)}],{stdio:'ignore'});${sleeper}`)}],{stdio:'ignore'});${sleeper}`],{windowsHide:true});
    const sibling=spawn(process.execPath,["-e",sleeper],{windowsHide:true});
    expect(root.pid).toBeDefined();const owned=await captureOwnedProcess({rootPid:root.pid!,agentSessionId:"session",providerId:"codex-cli",workerId:"worker"});const exited=once(root,"exit");
    expect(await terminateOwnedProcessTree({rootPid:owned.rootPid,expectedStartIdentity:owned.startedAt,agentSessionId:"session",reason:"CANCELLED"})).toBe("TERMINATED");
    await exited;expect(sibling.exitCode).toBeNull();
    expect(await terminateOwnedProcessTree({rootPid:owned.rootPid,expectedStartIdentity:owned.startedAt,agentSessionId:"session",reason:"CANCELLED"})).toBe("ALREADY_EXITED");
    sibling.kill();
  },10000);
  it("refuses a PID with a mismatched start identity",async()=>{const child=spawn(process.execPath,["-e",sleeper],{windowsHide:true});const owned=await captureOwnedProcess({rootPid:child.pid!,agentSessionId:"s",providerId:"claude-cli",workerId:"w"});expect(await terminateOwnedProcessTree({rootPid:owned.rootPid,expectedStartIdentity:"wrong",agentSessionId:"s",reason:"ABSOLUTE_TIMEOUT"})).toBe("IDENTITY_MISMATCH");child.kill();});
});
