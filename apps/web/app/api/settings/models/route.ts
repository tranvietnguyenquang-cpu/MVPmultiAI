import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@project-relay/database";
import { isModelSupported, isReasoningEffortAllowed } from "@project-relay/shared";
import { ApiError, apiErrorResponse } from "../../../../lib/api-errors";
import { classifyRequest } from "../../../../lib/csrf";
import { requireLocalSession } from "../../../../lib/local-auth";

const bodySchema = z.object({
  defaultClaudeModel: z.string().trim().min(1).max(200).nullable().optional(),
  defaultCodexModel: z.string().trim().min(1).max(200).nullable().optional(),
  defaultCodexReasoningEffort: z.string().trim().min(1).max(50).nullable().optional(),
});

export async function GET() {
  try {
    const settings = await prisma.applicationSettings.findUnique({ where: { id: "singleton" } });
    return NextResponse.json({
      defaultClaudeModel: settings?.defaultClaudeModel ?? null,
      defaultCodexModel: settings?.defaultCodexModel ?? null,
      defaultCodexReasoningEffort: settings?.defaultCodexReasoningEffort ?? null,
    });
  } catch (error) {
    return apiErrorResponse(error, "GET /api/settings/models");
  }
}

/** Application-wide model defaults (see also PUT /api/projects/[id]/model-defaults for the project-level tier). Every value is re-validated against the server-side registry here - never trusted as a raw browser string beyond that. */
export async function PUT(request: NextRequest) {
  try {
    const gate = classifyRequest(request);
    if (gate === "cross-origin") throw new ApiError("FORBIDDEN", "Cross-origin requests are not permitted.");
    if (gate === "unauthenticated") throw new ApiError("UNAUTHENTICATED", "Missing or invalid CSRF token.");
    const session = await requireLocalSession(request);
    if (!session) throw new ApiError("UNAUTHENTICATED", "Local session required.");

    const body = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) throw new ApiError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid settings input.");

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
    const settings = await prisma.applicationSettings.upsert({
      where: { id: "singleton" },
      create: { id: "singleton", ...data },
      update: data,
    });
    return NextResponse.json({
      defaultClaudeModel: settings.defaultClaudeModel,
      defaultCodexModel: settings.defaultCodexModel,
      defaultCodexReasoningEffort: settings.defaultCodexReasoningEffort,
    });
  } catch (error) {
    return apiErrorResponse(error, "PUT /api/settings/models");
  }
}
