import { NextRequest, NextResponse } from "next/server";
import { getConversationWithDetails } from "@project-relay/database";
import { ApiError, apiErrorResponse } from "../../../../lib/api-errors";
import { toConversationMessageDto, toHandoffCapsuleDto, toProviderSessionDto, toRoutingDecisionDto } from "../../../../lib/conversation-dto";
import { findAccessibleProject } from "../../../../lib/project-access";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const projectId = request.nextUrl.searchParams.get("projectId");
    if (!projectId) throw new ApiError("VALIDATION_ERROR", "projectId is required.");

    const project = await findAccessibleProject(projectId);
    if (!project) throw new ApiError("NOT_FOUND", "Project not found.");

    const conversation = await getConversationWithDetails(id);
    if (!conversation || conversation.projectId !== project.id) throw new ApiError("NOT_FOUND", "Conversation not found.");

    return NextResponse.json({
      id: conversation.id,
      projectId: conversation.projectId,
      title: conversation.title,
      status: conversation.status,
      activeProviderId: conversation.activeProviderId,
      currentCheckpointId: conversation.currentCheckpointId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      messages: conversation.messages.map(toConversationMessageDto),
      providerSessions: conversation.providerSessions.map(toProviderSessionDto),
      handoffCapsules: conversation.handoffCapsules.map(toHandoffCapsuleDto),
      routingDecisions: conversation.routingDecisions.map(toRoutingDecisionDto)
    });
  } catch (error) {
    return apiErrorResponse(error, "GET /api/conversations/[id]");
  }
}
