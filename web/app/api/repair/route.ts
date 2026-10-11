import type { EditTurn } from "@core/edit.js";
import { startRepairJob } from "@core/jobs.js";
import { WorkflowSchema } from "@core/schema.js";
import { getRun, getWorkflow } from "@core/store.js";
import { apiError, readJson } from "../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { run_id, step, workflow?, history? } -> 202 { jobId }. Subscribe at /api/jobs/:jobId/events.
 * Gemini proposes a fix for the step that failed in that run, and each fix is test-run with the run's params
 * (real TinyFish calls, not saved to run history) until one passes or 3 rounds are used. The last event,
 * repair_result, carries { workflow, reply, diff, changed, verified, rounds, test }. `workflow` is the copy to fix
 * (it may carry unsaved edits); it defaults to the latest saved version. Nothing is saved; POST /api/workflows
 * with source "repair" to save.
 */
export async function POST(request: Request) {
  const body = await readJson(request);
  const runId = typeof body?.run_id === "string" ? body.run_id : "";
  const step = typeof body?.step === "string" ? body.step : "";
  if (!runId || !step) return apiError(400, "missing_fields", "Send the run_id and the step to repair.");
  const run = getRun(runId);
  if (!run) return apiError(404, "run_not_found", "That run doesn't exist.");

  let workflow = getWorkflow(run.workflow);
  if (body?.workflow !== undefined) {
    const check = WorkflowSchema.safeParse(body.workflow);
    if (!check.success) return apiError(400, "invalid_workflow", "The workflow being repaired is malformed.", { errors: check.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) });
    workflow = check.data;
  }
  if (!workflow) return apiError(404, "workflow_not_found", `There's no saved workflow named "${run.workflow}".`);
  if (workflow.name !== run.workflow) return apiError(400, "wrong_workflow", `That run belongs to "${run.workflow}", not "${workflow.name}".`);

  const history: EditTurn[] = Array.isArray(body?.history)
    ? body.history.flatMap((t: unknown) => {
        const r = t as Record<string, unknown> | null;
        return r && (r.role === "user" || r.role === "assistant") && typeof r.text === "string" ? [{ role: r.role, text: r.text }] : [];
      })
    : [];
  const record = run.steps.find((s) => s.id === step);
  if (!record) return apiError(400, "unknown_step", `Run ${run.run_id} has no step "${step}".`);
  if (record.status === "ok") return apiError(400, "nothing_to_repair", `Step "${step}" passed in that run; there's nothing to repair.`);
  const job = startRepairJob(workflow, run, step, history);
  return Response.json({ jobId: job.id }, { status: 202 });
}
