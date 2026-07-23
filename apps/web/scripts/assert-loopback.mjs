import { assertLoopbackHost } from "@project-relay/shared";

const host = process.env.PROJECT_RELAY_BIND_HOST?.trim() || "127.0.0.1";

try {
  assertLoopbackHost(host, "PROJECT_RELAY_BIND_HOST");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("This build only supports local-first operation; refusing to start on a non-loopback host.");
  process.exit(1);
}

console.log(`Loopback bind check passed for host '${host}'.`);
