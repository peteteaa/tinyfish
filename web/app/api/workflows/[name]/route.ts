import { deleteWorkflow, getWorkflow, listVersions } from "@core/store.js";
import { apiError } from "../../../../lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const v = new URL(request.url).searchParams.get("version");
  const workflow = getWorkflow(name, v ? Number(v) : undefined);
  if (!workflow) return apiError(404, "workflow_not_found", `There's no saved workflow named "${name}".`);
  return Response.json({ workflow, versions: listVersions(name) });
}

/** Deletes every version of the workflow and its run history. */
export async function DELETE(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!deleteWorkflow(name)) return apiError(404, "workflow_not_found", `There's no saved workflow named "${name}".`);
  return Response.json({ deleted: name });
}
