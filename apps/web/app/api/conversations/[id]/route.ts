import { NextRequest, NextResponse } from "next/server";
import { getConversationWithDetails } from "@project-relay/database";
import { findAccessibleProject } from "../../../../lib/project-access";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = request.nextUrl.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId is required." }, { status: 400 });

  const project = await findAccessibleProject(projectId);
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  const conversation = await getConversationWithDetails(id);
  if (!conversation || conversation.projectId !== project.id) {
    return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  }

  return NextResponse.json({
    ...conversation,
    handoffCapsules: conversation.handoffCapsules.map((capsule: typeof conversation.handoffCapsules[number]) => ({
      id: capsule.id,
      conversationId: capsule.conversationId,
      fromProviderId: capsule.fromProviderId,
      toProviderId: capsule.toProviderId,
      version: capsule.version,
      checksum: capsule.checksum,
      createdAt: capsule.createdAt
    }))
  });
}
