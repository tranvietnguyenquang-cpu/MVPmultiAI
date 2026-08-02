import { NextRequest, NextResponse } from "next/server";
import { prisma as legacyPrisma } from "@project-relay/database";
import { createLegacyPreviewReport } from "@project-relay/relay-v2-orchestrator";
import { getRelayV2Database } from "@project-relay/relay-v2-persistence";
import { relayV2ApiError } from "../../../../../lib/relay-v2/api";
import { v2LegacyReportSchema } from "../../../../../lib/relay-v2/contracts";
import { assertRelayV2Enabled, requireRelayV2Mutation } from "../../../../../lib/relay-v2/server";

export async function GET() {
  try {
    assertRelayV2Enabled();
    const projects = await legacyPrisma.project.findMany({
      where: { archivedAt: null },
      select: { id: true, name: true, _count: { select: { tasks: true, approvals: true } } },
      orderBy: { name: "asc" }
    });
    return NextResponse.json(projects);
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/legacy/report");
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireRelayV2Mutation(request);
    const input = v2LegacyReportSchema.parse(await request.json());
    const { client } = await getRelayV2Database();
    const result = await createLegacyPreviewReport({
      database: client,
      ...input,
      actor: "local-user",
      reader: {
        readProjects: async ids => legacyPrisma.project.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true, tasks: { select: { id: true, status: true } }, _count: { select: { approvals: true } } }
        }).then(projects => projects.map(project => ({ id: project.id, name: project.name, tasks: project.tasks, approvalCount: project._count.approvals })))
      }
    });
    return NextResponse.json({ ...result, importEnabled: false });
  } catch (error) {
    return relayV2ApiError(error, "POST /api/v2/legacy/report");
  }
}
