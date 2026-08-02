import { NextRequest } from "next/server";
import { executionStatusSchema, isTerminalExecutionStatus } from "@project-relay/relay-v2-domain";
import { ExecutionNotFoundError } from "@project-relay/relay-v2-execution";
import { relayV2ApiError } from "../../../../../../lib/relay-v2/api";
import { v2ExecutionCursorSchema, v2ExecutionProjectQuerySchema } from "../../../../../../lib/relay-v2/contracts";
import { getRelayV2ExecutionServices, requireRelayV2Read } from "../../../../../../lib/relay-v2/server";

const encoder = new TextEncoder();

function configuredDuration(name: string, fallback: number): number {
  const configured = process.env[name];
  if (configured === undefined) return fallback;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireRelayV2Read(request);
    const sessionId = (await params).id;
    const projectId = v2ExecutionProjectQuerySchema.parse(request.nextUrl.searchParams.get("projectId"));
    // Native EventSource sends Last-Event-ID on reconnect. Prefer it over the
    // original URL cursor so a long-lived client resumes from its latest event.
    const cursorValue = request.headers.get("last-event-id") ?? request.nextUrl.searchParams.get("cursor") ?? "0";
    let cursor = v2ExecutionCursorSchema.parse(cursorValue);
    const { engine, runtime } = await getRelayV2ExecutionServices();
    const session = await engine.getSession(sessionId);
    if (!session || session.projectId !== projectId) throw new ExecutionNotFoundError("Execution session not found for this project.");
    runtime.start();
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const deadline = Date.now() + configuredDuration("RELAY_V2_SSE_CONNECTION_LIFETIME_MS", 30_000);
        const pollMs = configuredDuration("RELAY_V2_SSE_POLL_MS", 75);
        try {
          controller.enqueue(encoder.encode("retry: 250\n\n"));
          while (!closed && !request.signal.aborted && Date.now() < deadline) {
            const events = await engine.listEvents(sessionId, cursor, 100);
            for (const event of events) {
              if (event.sequence <= cursor) continue;
              cursor = event.sequence;
              controller.enqueue(encoder.encode(`id: ${event.sequence}\nevent: execution\ndata: ${JSON.stringify({
                sequence: event.sequence, eventType: event.eventType, level: event.level,
                message: event.message, payload: JSON.parse(event.payloadJson), createdAt: event.createdAt
              })}\n\n`));
            }
            const current = await engine.getSession(sessionId);
            if (!current) break;
            if (isTerminalExecutionStatus(executionStatusSchema.parse(current.status)) && events.length === 0) {
              controller.enqueue(encoder.encode(`event: complete\ndata: ${JSON.stringify({ status: current.status, cursor })}\n\n`));
              break;
            }
            await new Promise(resolve => setTimeout(resolve, pollMs));
          }
        } finally {
          if (!closed) { closed = true; controller.close(); }
        }
      },
      cancel() { closed = true; }
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }
    });
  } catch (error) {
    return relayV2ApiError(error, "GET /api/v2/executions/[id]/events");
  }
}
