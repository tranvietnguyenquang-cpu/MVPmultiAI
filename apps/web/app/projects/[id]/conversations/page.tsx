import { notFound } from "next/navigation";
import Link from "next/link";
import { listProjectConversations, prisma } from "@project-relay/database";
import { ConversationForm } from "../../../../components/conversation-form";

export const dynamic = "force-dynamic";

export default async function ConversationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await prisma.project.findUnique({ where: { id } });
  if (!project) notFound();

  const conversations = await listProjectConversations(id);

  return (
    <>
      <div className="eyebrow">{project.name} / Conversations</div>
      <h1>Conversations</h1>
      <p className="subtle">One continuous timeline per conversation. Route each prompt to Auto, Codex, or Claude.</p>
      <div className="grid">
        <section className="card span8">
          <h2>Active conversations</h2>
          {conversations.length ? (
            <div className="stack">
              {conversations.map(conversation => (
                <Link className="card" href={`/projects/${project.id}/conversations/${conversation.id}`} key={conversation.id}>
                  <div className="row">
                    <div>
                      <h3>{conversation.title}</h3>
                      <div className="mono subtle">{conversation.updatedAt.toLocaleString()}</div>
                    </div>
                    <span className="pill">{conversation.status}</span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="empty">No conversations yet.</div>
          )}
        </section>
        <section className="card span4">
          <h2>New conversation</h2>
          <ConversationForm projectId={project.id} />
        </section>
      </div>
    </>
  );
}
