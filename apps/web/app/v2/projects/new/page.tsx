import { notFound } from "next/navigation";
import { RelayV2ProjectForm } from "../../../../components/relay-v2/project-form";
import { isRelayV2Enabled } from "../../../../lib/relay-v2/server";

export default function RelayV2NewProjectPage() {
  if (!isRelayV2Enabled()) notFound();
  return <><div className="eyebrow">Relay v2 / Projects / Add</div><h1>Add local project</h1><div className="grid"><section className="card span8"><RelayV2ProjectForm/></section><section className="card span4"><h2>Safety boundary</h2><p className="subtle">The path must be an absolute Git repository root. Relay records only this project; creation does not initialize memory, modify files, or execute commands.</p></section></div></>;
}
