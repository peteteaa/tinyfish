import { resolveParams } from "@core/executor.js";
import { startRunJob } from "@core/jobs.js";
import { getWorkflow, listRuns } from "@core/store.js";
import { apiError, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

/** POST { params, version? } -> 202 { jobId }. Params are checked before the run starts. */
export async function POST(request: Request, { params }: Ctx) {
  const { name } = await params;
  const body = (await readJson(request)) ?? {};
  const version = typeof body.version === "number" ? body.version : undefined;
  const workflow = getWorkflow(name, version);
  if (!workflow) return apiError(404, "workflow_not_found", `There's no saved workflow named "${name}".`);
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
  return Response.json({ jobId: job.id }, { status: 202 });
}

/** GET ?limit= -> run summaries, most recent first. */
export async function GET(request: Request, { params }: Ctx) {
  const { name } = await params;
  const limit = Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")) || 20, 1), 200);
  const runs = listRuns(name, limit).map(({ run_id, version, status, started_at, finished_at, duration_ms, params, error }) => ({
    run_id, version, status, started_at, finished_at, duration_ms, params, error,
  }));
  return Response.json({ runs });
}
