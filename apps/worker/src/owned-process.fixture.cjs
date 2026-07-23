const { spawn } = require("node:child_process");

const role = process.argv[2];
const keepAlive = () => setInterval(() => {}, 1_000);

if (role === "grandchild" || role === "sibling") {
  keepAlive();
} else if (role === "child") {
  const grandchild = spawn(process.execPath, [__filename, "grandchild"], { stdio: "ignore", windowsHide: true });
  process.stdout.write(`${JSON.stringify({ childPid: process.pid, grandchildPid: grandchild.pid })}\n`);
  keepAlive();
} else {
  const child = spawn(process.execPath, [__filename, "child"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  child.stdout.once("data", (chunk) => {
    const descendants = JSON.parse(chunk.toString("utf8"));
    process.stdout.write(`${JSON.stringify({ rootPid: process.pid, childPid: child.pid, ...descendants })}\n`);
  });
  keepAlive();
}
