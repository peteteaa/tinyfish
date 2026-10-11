import { editWorkflow, type EditTurn } from "@core/edit.js";
import { validateWorkflow } from "@core/schema.js";
import { log } from "@core/env.js";
import { apiError, readJson } from "../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST { workflow, instruction, history? } -> 200 { workflow, reply, diff, changed }.
 * Gemini applies the instruction to the workflow. Nothing is saved; POST /api/workflows to save the result.
 */
export async function POST(request: Request) {
  const body = await readJson(request);
  const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
  if (!instruction) return apiError(400, "missing_instruction", "Describe the change you want.");
  if (instruction.length > 4000) return apiError(400, "instruction_too_long", "Keep the request under 4,000 characters.");
  const check = validateWorkflow(body?.workflow);
  if (!check.ok) return apiError(400, "invalid_workflow", "The workflow being edited has errors.", { errors: check.errors });
  const history: EditTurn[] = Array.isArray(body?.history)
    ? body.history.flatMap((t: unknown) => {
        const r = t as Record<string, unknown> | null;
        return r && (r.role === "user" || r.role === "assistant") && typeof r.text === "string" ? [{ role: r.role, text: r.text }] : [];
      })
    : [];
  try {
    return Response.json(await editWorkflow(check.workflow, instruction, history));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`edit failed: ${message}`);
    return apiError(502, "edit_failed", message);
  }
}
