import { notFound } from "next/navigation";
import { RelayV2LegacyPreview } from "../../../../components/relay-v2/legacy-preview";
import { getRelayV2Orchestrator, isRelayV2Enabled } from "../../../../lib/relay-v2/server";

export const dynamic = "force-dynamic";
export default async function RelayV2LegacyPreviewPage() {
  if (!isRelayV2Enabled()) notFound();
  const projects = await (await getRelayV2Orchestrator()).listProjects();
  return <><div className="eyebrow">Relay v2 / Legacy report</div><h1>Read-only migration preview</h1><p className="subtle">This report reads selected PostgreSQL rows and writes only report metadata to SQLite. Actual import is disabled.</p>{projects.length ? <RelayV2LegacyPreview v2Projects={projects.map(project => ({ id: project.id, name: project.name }))}/> : <div className="empty">Create a Relay v2 project before attaching a legacy report.</div>}</>;
}
