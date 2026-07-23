import { providerRegistry } from "@project-relay/providers";
import type { TaskCapsuleContent } from "@project-relay/shared";

/**
 * Real-CLI-gated smoke test for structured stream parsing + session identity.
 * Runs one real read-only ASK-mode session against the installed, authenticated
 * CLI and checks that the assistant answer was actually extracted from the
 * structured stream (never raw JSON) and that an authoritative external session
 * id was observed. Never part of test:all/CI - invoke explicitly via
 * `npm run smoke:session:codex` / `npm run smoke:session:claude`.
 */
async function main() {
  const id = process.argv[2] as "codex-cli" | "claude-cli" | undefined;
  if (!id) throw new Error("Provider ID required (codex-cli or claude-cli).");
  const provider = providerRegistry.get(id);

  const installation = await provider.refreshHealth();
  if (!installation.installed) {
    console.error(provider.setupInstructions);
    process.exitCode = 2;
    return;
  }
  const auth = await provider.probeAuthentication();
  if (!auth.available) {
    console.error(`${id} is ${auth.authentication.toLowerCase()}. ${provider.setupInstructions}`);
    process.exitCode = 2;
    return;
  }

  const session = await provider.createSession({ workspace: process.cwd(), taskId: "smoke-session-test", capability: "READ_ONLY" });
  const capsule: TaskCapsuleContent = {
    task: { id: "smoke-session-test", title: "Smoke test", objective: "Reply with a short greeting only; do not read or modify any files.", userRequest: "Say hello in one short sentence." },
    architectureDecisions: [],
    codingRules: "",
    sourceContext: [],
    knownIssues: "",
    acceptanceCriteria: [],
    latestTestEvidence: [],
    prohibitedChanges: [],
    conversationMode: "ASK"
  };

  let assistantText = "";
  const consume = (async () => {
    for await (const item of provider.streamEvents(session.id)) if (item.type === "stdout") assistantText += item.message;
  })();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    await provider.startSession(session, capsule, controller.signal);
    await consume;
  } finally {
    clearTimeout(timer);
  }

  console.log(JSON.stringify({ provider: id, externalSessionId: session.externalId ?? null, assistantTextLength: assistantText.length, assistantTextPreview: assistantText.slice(0, 200) }));

  if (!assistantText.trim()) {
    console.error("No assistant text was extracted from the structured stream.");
    process.exitCode = 1;
    return;
  }
  if (assistantText.trim().startsWith("{")) {
    console.error("Assistant text looks like raw JSON; structured parsing may have failed.");
    process.exitCode = 1;
    return;
  }
  if (!session.externalId) {
    console.warn("No authoritative external session id was observed; resume will start a fresh session next time instead of reusing this one.");
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
