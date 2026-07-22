import { NextRequest, NextResponse } from "next/server";
import { createConversation, listProjectConversations } from "@project-relay/database";
import { createConversationSchema } from "@project-relay/shared";
import { classifyRequest } from "../../../../../lib/csrf";
import { findAccessibleProject } from "../../../../../lib/project-access";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = await findAccessibleProject(id);
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });
  return NextResponse.json(await listProjectConversations(id));
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = classifyRequest(request);
  if (gate === "cross-origin") return NextResponse.json({ error: "Cross-origin requests are not permitted." }, { status: 403 });
  if (gate === "unauthenticated") return NextResponse.json({ error: "Missing or invalid CSRF token." }, { status: 401 });

  const { id } = await params;
  const project = await findAccessibleProject(id);
  if (!project) return NextResponse.json({ error: "Project not found." }, { status: 404 });

  const body = await request.json().catch(() => null);
  const parsed = createConversationSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid conversation input." }, { status: 400 });

  try {
    const conversation = await createConversation(project.id, parsed.data.title);
    return NextResponse.json(conversation, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Could not create conversation." }, { status: 500 });
  }
}
