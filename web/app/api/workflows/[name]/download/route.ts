import { getWorkflow } from "@core/store.js";
import { apiError } from "@/lib/api";
import { withUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET ?version= -> <name>.workflow.json as an attachment. */
export const GET = withUser(async (request: Request, { params }: { params: Promise<{ name: string }> }) => {
  const { name } = await params;
  const v = new URL(request.url).searchParams.get("version");
  const workflow = await getWorkflow(name, v ? Number(v) : undefined);
  if (!workflow) return apiError(404, "workflow_not_found", `There's no saved workflow named "${name}".`);
  return new Response(JSON.stringify(workflow, null, 2) + "\n", {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${workflow.name}.workflow.json"`,
    },
  });
});
