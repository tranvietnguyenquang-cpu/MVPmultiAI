import { notFound } from "next/navigation";
import { RELAY_HANDOFF_V1_TEMPLATE } from "@project-relay/relay-v2-domain";
import { RelayV2HandoffImport } from "../../../components/relay-v2/handoff-import";
import { getRelayV2Orchestrator, isRelayV2Enabled } from "../../../lib/relay-v2/server";

export const dynamic = "force-dynamic";
export default async function RelayV2ImportPage() {
  if (!isRelayV2Enabled()) notFound();
  const projects = await (await getRelayV2Orchestrator()).listProjects();
  return <><div className="eyebrow">Relay v2 / Import Handoff</div><h1>Validate before creating.</h1><p className="subtle">Safe YAML 1.2 and JSON only. Validation and preview do not persist a task.</p><RelayV2HandoffImport projects={projects.map(project => ({ id: project.id, name: project.name }))} template={RELAY_HANDOFF_V1_TEMPLATE}/></>;
}
