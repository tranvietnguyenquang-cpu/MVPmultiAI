import { NextRequest, NextResponse } from "next/server";
import { ApiError } from "../../../../../../lib/api-errors";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { getRelayV2ExecutionServices, getRelayV2Orchestrator, requireRelayV2Read } from "../../../../../../lib/relay-v2/server";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRelayV2Read(request);
    const project = await (await getRelayV2Orchestrator()).getProject((await params).id);
    if (!project) throw new ApiError("NOT_FOUND", "Project not found.");
    const evidence = await (await getRelayV2ExecutionServices()).engine.previewWorkspace(project.localPath);
    return NextResponse.json({
      evidenceHash: evidence.evidenceHash, branch: evidence.branch, head: evidence.head, dirty: evidence.dirty,
      stagedCount: evidence.stagedCount, unstagedCount: evidence.unstagedCount, untrackedCount: evidence.untrackedCount,
      status: evidence.status.map(item => ({ path: item.path, indexStatus: item.indexStatus, worktreeStatus: item.worktreeStatus, sensitive: item.sensitive }))
    });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/projects/[id]/workspace-evidence");
  }
}
