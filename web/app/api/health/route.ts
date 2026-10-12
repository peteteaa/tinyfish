import { STORAGE } from "@core/env.js";
import { AUTH_ENABLED } from "@/lib/authConfig";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public, so it lists no workflows (those belong to signed-in users). */
export async function GET() {
  return Response.json({ ok: true, storage: STORAGE, auth: AUTH_ENABLED ? "clerk" : "off" });
}
