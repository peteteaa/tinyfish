import { startLearnJob } from "@core/jobs.js";
import { apiError, readJson } from "../../../lib/api";

export const runtime = "nodejs";

/** POST { goal, name? } -> 202 { jobId }. Subscribe at /api/jobs/:jobId/events. */
export async function POST(request: Request) {
  const body = await readJson(request);
  const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
  if (!goal) return apiError(400, "missing_goal", "Describe the web task you want learned.");
  if (goal.length > 2000) return apiError(400, "goal_too_long", "Keep the task under 2,000 characters.");
  const name = typeof body?.name === "string" && body.name ? body.name : undefined;
  const job = startLearnJob(goal, { name });
  return Response.json({ jobId: job.id }, { status: 202 });
}
