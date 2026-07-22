import { NextRequest, NextResponse } from "next/server";
import { getConversationWithDetails, listConversationMessages } from "@project-relay/database";
import { findAccessibleProject } from "../../../../../lib/project-access";

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

  return NextResponse.json(await listConversationMessages(id));
}
