import { STORAGE } from "@core/env.js";
import { listWorkflows } from "@core/store.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ ok: true, storage: STORAGE, workflows: (await listWorkflows()).map((w) => w.name) });
}
