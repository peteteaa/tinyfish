import { deleteWorkflow, getWorkflow, listVersions } from "@core/store.js";
import { apiError } from "../../../../lib/api";
import { withUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withUser(async (request: Request, { params }: { params: Promise<{ name: string }> }) => {
  const { name } = await params;
  const v = new URL(request.url).searchParams.get("version");
  const workflow = await getWorkflow(name, v ? Number(v) : undefined);
  if (!workflow) return apiError(404, "workflow_not_found", `There's no saved workflow named "${name}".`);
  return Response.json({ workflow, versions: await listVersions(name) });
});

/** Deletes every version of the workflow and its run history. */
export const DELETE = withUser(async (_request: Request, { params }: { params: Promise<{ name: string }> }) => {
  const { name } = await params;
  if (!(await deleteWorkflow(name))) return apiError(404, "workflow_not_found", `There's no saved workflow named "${name}".`);
  return Response.json({ deleted: name });
});
