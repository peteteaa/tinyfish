import { getRun } from "@core/store.js";
import { apiError } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const run = getRun(runId);
  if (!run) return apiError(404, "run_not_found", "That run doesn't exist.");
  return Response.json({ run });
}
