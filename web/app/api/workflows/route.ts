import { validateWorkflow } from "@core/schema.js";
import { listWorkflows, saveWorkflow, type VersionSource } from "@core/store.js";
import { apiError, readJson } from "../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SOURCES: VersionSource[] = ["learned", "web", "cli", "import", "repair"];

export async function GET() {
  return Response.json({ workflows: await listWorkflows() });
}

/** POST { workflow, source? } -> 201 { workflow }. A new name starts at v1; an existing name adds a version. */
export async function POST(request: Request) {
  const body = await readJson(request);
  if (!body?.workflow) return apiError(400, "missing_workflow", "Send the workflow as { workflow: {...} }.");
  const source = SOURCES.includes(body.source as VersionSource) ? (body.source as VersionSource) : "web";
  const check = validateWorkflow(body.workflow);
  if (!check.ok) return apiError(400, "invalid_workflow", "The workflow has errors. Fix them and save again.", { errors: check.errors });
  const workflow = await saveWorkflow(check.workflow, source);
  return Response.json({ workflow }, { status: 201 });
}
