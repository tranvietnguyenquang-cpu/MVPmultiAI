import { NextRequest, NextResponse } from "next/server";
import { getConversationExecution, getConversationWithDetails } from "@project-relay/database";
import { ApiError, apiErrorResponse } from "../../../../../../lib/api-errors";
import { toConversationMessageDto, toProviderSessionDto } from "../../../../../../lib/conversation-dto";
import { findAccessibleProject } from "../../../../../../lib/project-access";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; executionId: string }> }) {
  try {
    const { id: conversationId, executionId } = await params;
    const projectId = request.nextUrl.searchParams.get("projectId");
    if (!projectId) throw new ApiError("VALIDATION_ERROR", "projectId is required.");

    const project = await findAccessibleProject(projectId);
    if (!project) throw new ApiError("NOT_FOUND", "Project not found.");

    const conversation = await getConversationWithDetails(conversationId);
    if (!conversation || conversation.projectId !== project.id) throw new ApiError("NOT_FOUND", "Conversation not found.");

    const execution = await getConversationExecution(executionId);
    if (!execution || execution.agentSession.projectId !== project.id || execution.agentSession.conversationId !== conversation.id) {
      throw new ApiError("NOT_FOUND", "Execution not found.");
    }

    return NextResponse.json({
      status: execution.agentSession.state,
      selectedProvider: execution.agentSession.providerId,
      requestedModel: execution.agentSession.requestedModel,
      resolvedModel: execution.agentSession.resolvedModel,
      reasoningEffort: execution.agentSession.reasoningEffort,
      modelSource: execution.agentSession.modelSource,
      providerVersion: execution.agentSession.providerVersion,
      startedAt: execution.agentSession.startedAt ?? execution.agentSession.createdAt,
      failureCode: execution.agentSession.failureCode,
      providerSession: execution.providerSession ? toProviderSessionDto(execution.providerSession) : null,
      events: execution.events.map(item => ({
        id: item.id.toString(),
        type: item.type,
        stream: item.stream,
        message: item.message,
        createdAt: item.createdAt
      })),
      assistantMessage: execution.assistantMessage ? toConversationMessageDto(execution.assistantMessage) : null,
      error: execution.agentSession.error
    });
  } catch (error) {
    return apiErrorResponse(error, "GET /api/conversations/[id]/executions/[executionId]");
  }
}
