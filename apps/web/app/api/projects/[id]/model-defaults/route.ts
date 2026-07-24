import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@project-relay/database";
import { isModelSupported, isReasoningEffortAllowed } from "@project-relay/shared";
import { ApiError, apiErrorResponse } from "../../../../../lib/api-errors";
import { classifyRequest } from "../../../../../lib/csrf";
import { requireLocalSession } from "../../../../../lib/local-auth";
import { findAccessibleProject } from "../../../../../lib/project-access";

const bodySchema = z.object({
  defaultClaudeModel: z.string().trim().min(1).max(200).nullable().optional(),
  defaultCodexModel: z.string().trim().min(1).max(200).nullable().optional(),
  defaultCodexReasoningEffort: z.string().trim().min(1).max(50).nullable().optional(),
});

/** Project-level model defaults, one tier below explicit execution selection and above the application default (see @project-relay/shared resolveEffectiveModel). Every value is re-validated against the server-side registry - never trusted as a raw browser string beyond that. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const gate = classifyRequest(request);
    if (gate === "cross-origin") throw new ApiError("FORBIDDEN", "Cross-origin requests are not permitted.");
    if (gate === "unauthenticated") throw new ApiError("UNAUTHENTICATED", "Missing or invalid CSRF token.");
    const session = await requireLocalSession(request);
    if (!session) throw new ApiError("UNAUTHENTICATED", "Local session required.");

    const { id } = await params;
    const project = await findAccessibleProject(id);
    if (!project) throw new ApiError("NOT_FOUND", "Project not found.");

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) throw new ApiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid model-defaults input.");

    const { defaultClaudeModel, defaultCodexModel, defaultCodexReasoningEffort } = parsed.data;
    if (defaultClaudeModel && !isModelSupported("claude-cli", defaultClaudeModel)) throw new ApiError("VALIDATION_ERROR", `claude-cli does not support model '${defaultClaudeModel}'.`);
    if (defaultCodexModel && !isModelSupported("codex-cli", defaultCodexModel)) throw new ApiError("VALIDATION_ERROR", `codex-cli does not support model '${defaultCodexModel}'.`);
    if (defaultCodexReasoningEffort && !isReasoningEffortAllowed("codex-cli", defaultCodexModel ?? null, defaultCodexReasoningEffort)) {
      throw new ApiError("VALIDATION_ERROR", `codex-cli model '${defaultCodexModel ?? "default"}' does not support reasoning effort '${defaultCodexReasoningEffort}'.`);
    }

    const data = {
      ...(defaultClaudeModel !== undefined ? { defaultClaudeModel } : {}),
      ...(defaultCodexModel !== undefined ? { defaultCodexModel } : {}),
      ...(defaultCodexReasoningEffort !== undefined ? { defaultCodexReasoningEffort } : {}),
    };
    const updated = await prisma.project.update({ where: { id: project.id }, data });
    return NextResponse.json({
      defaultClaudeModel: updated.defaultClaudeModel,
      defaultCodexModel: updated.defaultCodexModel,
      defaultCodexReasoningEffort: updated.defaultCodexReasoningEffort,
    });
  } catch (error) {
    return apiErrorResponse(error, "PUT /api/projects/[id]/model-defaults");
  }
}
