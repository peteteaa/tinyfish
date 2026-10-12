import { getRun } from "@core/store.js";
import { apiError } from "@/lib/api";
import { withUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (_request: Request, { params }: { params: Promise<{ runId: string }> }) => {
  const { runId } = await params;
  const run = await getRun(runId);
  if (!run) return apiError(404, "run_not_found", "That run doesn't exist.");
  return Response.json({ run });
});
