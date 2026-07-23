import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@project-relay/database";
import { classifyRequest } from "../../../../../../../lib/csrf";
import { ApiError, apiErrorResponse } from "../../../../../../../lib/api-errors";
import { findAccessibleProject } from "../../../../../../../lib/project-access";

/**
 * This route records an idempotent cancellation request. The owning worker observes
 * the terminal state and terminates the exact persisted process tree; it never
 * accepts a PID or process identity from the browser.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; executionId: string }> },
) {
  try {
    const gate = classifyRequest(request);
    if (gate !== "ok") {
      throw new ApiError(
        gate === "cross-origin" ? "FORBIDDEN" : "UNAUTHENTICATED",
        "Same-origin local authentication is required.",
      );
    }

    const { id, executionId } = await params;
    const projectId = request.nextUrl.searchParams.get("projectId");
    const project = projectId ? await findAccessibleProject(projectId) : null;
    if (!project) throw new ApiError("NOT_FOUND", "Project not found.");

    const session = await prisma.agentSession.findUnique({ where: { id: executionId } });
    if (!session || session.conversationId !== id || session.projectId !== project.id) {
      throw new ApiError("NOT_FOUND", "Execution not found.");
    }

    const requestedAt = new Date();
    const changed = await prisma.agentSession.updateMany({
      where: { id: executionId, state: { in: ["QUEUED", "STARTING", "RUNNING"] } },
      data: {
        state: "CANCELLED",
        endedAt: requestedAt,
        failureCode: "PROVIDER_CANCELLED",
        error: "Execution cancelled by user.",
        ...(session.state === "QUEUED"
          ? {}
          : {
              providerTerminationRequestedAt: requestedAt,
              providerTerminationReason: "CANCELLED",
            }),
      },
    });
    if (changed.count) {
      await prisma.outboxEvent.deleteMany({
        where: { jobId: executionId, status: { in: ["PENDING", "FAILED"] } },
      });
    }

    const cancelled = changed.count > 0 || session.state === "CANCELLED";
    return NextResponse.json({
      id: executionId,
      state: cancelled ? "CANCELLED" : session.state,
      cancelled,
      // A running provider is not declared terminated until its worker records a
      // bounded owned-tree termination result.
      termination: session.state === "QUEUED" ? "not-required" : cancelled ? "requested" : "not-applicable",
    });
  } catch (error) {
    return apiErrorResponse(error, "POST execution cancel");
  }
}
