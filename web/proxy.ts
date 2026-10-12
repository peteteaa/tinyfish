import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { AUTH_ENABLED } from "./lib/authConfig";

// Clerk reads the session for every request so pages and routes can call auth(). Access is checked in each page
// (asUser: signed out -> sign-in) and API route (withUser: signed out -> 401), see lib/auth.ts.
export default AUTH_ENABLED ? clerkMiddleware() : () => NextResponse.next();

export const config = {
  matcher: [
    // Skip Next.js internals and static files
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
