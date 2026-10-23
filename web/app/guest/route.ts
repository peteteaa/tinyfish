import { NextResponse } from "next/server";
import { GUEST_COOKIE, GUEST_ENABLED, GUEST_LIMITS, SIGN_IN_URL } from "@/lib/authConfig";
import { guestId, newGuestId } from "@/lib/guest";

export const dynamic = "force-dynamic";

/** GET /guest: start (or resume) trying the app as a guest, then go home. A plain link works, so it can be shared. */
export async function GET(request: Request) {
  if (!GUEST_ENABLED) return NextResponse.redirect(new URL(SIGN_IN_URL, request.url));
  const response = NextResponse.redirect(new URL("/", request.url));
  // Keep an existing guest id so coming back to this link doesn't reset the guest's limit or hide their workflows.
  if (!(await guestId())) {
    response.cookies.set(GUEST_COOKIE, newGuestId(), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: GUEST_LIMITS.days * 24 * 60 * 60,
    });
  }
  return response;
}
