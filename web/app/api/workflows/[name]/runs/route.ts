import { after } from "next/server";
import { resolveParams } from "@core/executor.js";
import { startRunJob } from "@core/jobs.js";
import { validateWorkflow, type Workflow } from "@core/schema.js";
import { getWorkflow, listRuns } from "@core/store.js";
import { apiError, readJson } from "@/lib/api";
import { withUser } from "@/lib/auth";

export const runtime = "nodejs";
/** Seconds a job may run after the response (Vercel; the platform caps this per plan). */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

/**
 * POST { params, version? } -> 202 { jobId }. Params are checked before the run starts.
 * POST { params, workflow } test-runs unsaved changes instead; that run isn't saved to run history.
 */
export const POST = withUser(async (request: Request, { params }: Ctx) => {
  const { name } = await params;
  const body = (await readJson(request)) ?? {};
  const version = typeof body.version === "number" ? body.version : undefined;
  let workflow: Workflow | undefined = await getWorkflow(name, version);
  if (!workflow) return apiError(404, "workflow_not_found", `There's no saved workflow named "${name}".`);
  if (body.workflow !== undefined) {
    const check = validateWorkflow(body.workflow);
    if (!check.ok) return apiError(400, "invalid_workflow", "The changes have errors.", { errors: check.errors });
    if (check.workflow.name !== name) return apiError(400, "wrong_workflow", `That workflow is "${check.workflow.name}", not "${name}".`);
    // No version: the executor only records runs of saved versions.
    const { version: _v, ...unsaved } = check.workflow;
    workflow = unsaved;
  }
  const input = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? (body.params as Record<string, unknown>) : {};
  // Empty form fields mean "use the default".
  for (const [k, v] of Object.entries(input)) if (v === "" || v === null) delete input[k];
  let resolved: Record<string, unknown>;
  try {
    resolved = resolveParams(workflow, input);
  } catch (err) {
    return apiError(400, "invalid_params", err instanceof Error ? err.message : String(err));
  }
  const job = startRunJob(workflow, resolved);
  // On serverless hosts the function would stop once the response is sent; after() keeps the job running.
  after(() => job.done);
  return Response.json({ jobId: job.id }, { status: 202 });
}, { paid: "job" });

/** GET ?limit= -> run summaries, most recent first. */
export const GET = withUser(async (request: Request, { params }: Ctx) => {
  const { name } = await params;
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")) || 20, 1), 200);
  const runs = (await listRuns(name, limit)).map(({ run_id, version, status, started_at, finished_at, duration_ms, params, error }) => ({
    run_id, version, status, started_at, finished_at, duration_ms, params, error,
  }));
  return Response.json({ runs });
});
