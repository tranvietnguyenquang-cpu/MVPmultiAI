import { NextRequest, NextResponse } from "next/server";
import { Queue } from "bullmq";
import { commitVerificationCleanup, previewVerificationCleanup } from "@project-relay/database";
import { classifyRequest } from "../../../lib/csrf";
import { ApiError, apiErrorResponse } from "../../../lib/api-errors";

const localAdmin = () => process.env.PROJECT_RELAY_LOCAL_ADMIN === "true";
export async function GET(){ if (!localAdmin()) return NextResponse.json({ error: "Not found." }, { status: 404 }); return NextResponse.json(await previewVerificationCleanup()); }
export async function POST(request: NextRequest){ try { if (!localAdmin()) throw new ApiError("FORBIDDEN", "Local-admin mode is required."); const gate = classifyRequest(request); if (gate !== "ok") throw new ApiError(gate === "cross-origin" ? "FORBIDDEN" : "UNAUTHENTICATED", "Same-origin local authentication is required."); const preview = await previewVerificationCleanup(); if (preview.refused.length) throw new ApiError("CONFLICT", "Cleanup refused because an ambiguous project was found."); const redisUrl = new URL(process.env.REDIS_URL ?? "redis://127.0.0.1:6379"); const queue = new Queue("conversation-messages", { connection: { host: redisUrl.hostname, port: Number(redisUrl.port || 6379), ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}) } }); try { for (const jobId of preview.queueJobIds) { const job = await queue.getJob(jobId); if (job) await job.remove(); } } finally { await queue.close(); } return NextResponse.json(await commitVerificationCleanup()); } catch (error) { return apiErrorResponse(error, "POST /api/verification-cleanup"); } }
