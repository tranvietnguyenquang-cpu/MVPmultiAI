import Link from "next/link";
import { notFound } from "next/navigation";
import { getRelayV2Orchestrator, isRelayV2Enabled } from "../../../lib/relay-v2/server";

export const dynamic = "force-dynamic";
export default async function RelayV2ProjectsPage() {
  if (!isRelayV2Enabled()) notFound();
  const projects = await (await getRelayV2Orchestrator()).listProjects();
  return <><div className="eyebrow">Relay v2 / Projects</div><h1>Local projects</h1><div className="row"><p className="subtle">Projects are stored in the side-by-side SQLite database.</p><div><Link className="button" href="/v2/projects/new">Add project</Link> <Link className="button secondary" href="/v2/projects/legacy-preview">Legacy preview</Link></div></div><div className="stack" style={{ marginTop: 28 }}>{projects.length ? projects.map(project => <section className="card" key={project.id}><div className="row"><div><h2>{project.name}</h2><div className="mono subtle">{project.localPath}</div></div><span className="pill">{project.slug}</span></div></section>) : <div className="empty">No Relay v2 projects. Add one before creating tasks.</div>}</div></>;
}
