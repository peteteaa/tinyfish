// Who's asking. Every page and API route that touches the store runs inside withUser/asUser, which bind the signed-in
// Clerk user as the store's owner (runAs in src/store.ts), so each user only sees and saves their own workflows,
// runs, traces and jobs. Jobs started by a request keep running as that user.

import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { LOCAL_OWNER, runAs } from "@core/store.js";
import { apiError } from "./api";
import { AUTH_ENABLED, SIGN_IN_URL } from "./authConfig";

/** The signed-in user's id, null when signed out. "local" when sign-in is off. */
export async function currentUserId(): Promise<string | null> {
  if (!AUTH_ENABLED) return LOCAL_OWNER;
  const { isAuthenticated, userId } = await auth();
  return isAuthenticated ? userId : null;
}

/** Route handlers: 401 when signed out, otherwise runs the handler as the user. */
export function withUser<A extends unknown[]>(handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    const owner = await currentUserId();
    if (!owner) return apiError(401, "signed_out", "Sign in to use workflow-memory.");
    return runAs(owner, () => handler(...args));
  };
}

/** Server components: sends signed-out visitors to sign in, otherwise renders as the user. */
export async function asUser<T>(render: () => Promise<T>): Promise<T> {
  const owner = await currentUserId();
  if (!owner) redirect(SIGN_IN_URL);
  return runAs(owner, render);
}
