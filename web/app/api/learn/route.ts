import { after } from "next/server";
import { startLearnJob } from "@core/jobs.js";
import { apiError, readJson } from "../../../lib/api";
import { withUser } from "@/lib/auth";

export const runtime = "nodejs";
/** Seconds a job may run after the response (Vercel; the platform caps this per plan). */
export const maxDuration = 300;

/** POST { goal, name? } -> 202 { jobId }. Subscribe at /api/jobs/:jobId/events. */
export const POST = withUser(async (request: Request) => {
  const body = await readJson(request);
  const goal = typeof body?.goal === "string" ? body.goal.trim() : "";
  if (!goal) return apiError(400, "missing_goal", "Describe the web task you want learned.");
  if (goal.length > 2000) return apiError(400, "goal_too_long", "Keep the task under 2,000 characters.");
  const name = typeof body?.name === "string" && body.name ? body.name : undefined;
  const job = startLearnJob(goal, { name });
  // On serverless hosts the function would stop once the response is sent; after() keeps the job running.
  after(() => job.done);
  return Response.json({ jobId: job.id }, { status: 202 });
}, { paid: "job" });
