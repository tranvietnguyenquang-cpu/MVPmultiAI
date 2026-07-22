import { NextRequest, NextResponse } from "next/server";
import { getConversationExecution, getConversationWithDetails } from "@project-relay/database";
import { findAccessibleProject } from "../../../../../../lib/project-access";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; executionId: string }> }) {
  const { id: conversationId, executionId } = await params;
  const projectId = request.nextUrl.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required." }, { status: 400 });

  const project = await findAccessibleProject(projectId);
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  const conversation = await getConversationWithDetails(conversationId);
  if (!conversation || conversation.projectId !== project.id) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }

  const execution = await getConversationExecution(executionId);
  if (!execution || execution.agentSession.projectId !== project.id || execution.agentSession.conversationId !== conversation.id) {
    return NextResponse.json({ error: "Execution not found." }, { status: 404 });
  }

  return NextResponse.json({
    status: execution.agentSession.state,
    selectedProvider: execution.agentSession.providerId,
    providerSession: execution.providerSession,
    events: execution.events.map(item => ({
      id: item.id.toString(),
      type: item.type,
      stream: item.stream,
      message: item.message,
      createdAt: item.createdAt
    })),
    assistantMessage: execution.assistantMessage,
    error: execution.agentSession.error
  });
}
