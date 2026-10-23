// Guest mode. GET /guest gives the browser a random guest id in an httpOnly cookie, and lib/auth.ts treats that id as
// the store's owner like any signed-in user, so a guest's workflows and runs are private to that browser. Nothing
// carries over on sign-up. Paid actions are capped (GUEST_LIMITS); the jobs table is the ledger: learn, run and repair
// already record a job, and an AI edit records a finished "edit" job here.

import { cookies } from "next/headers";
import { jobStore, newId } from "@core/store.js";
import { GUEST_COOKIE, GUEST_LIMITS, isGuestId } from "./authConfig";

const GUEST_PREFIX = "guest_";
const DAY_MS = 24 * 60 * 60 * 1000;

export const newGuestId = () => `${GUEST_PREFIX}${crypto.randomUUID()}`;

/** This browser's guest id, null without a valid guest cookie. */
export async function guestId(): Promise<string | null> {
  const value = (await cookies()).get(GUEST_COOKIE)?.value;
  return isGuestId(value) ? value : null;
}

/** Why the current guest can't start another paid action, or null when they can. Call inside runAs(guest). */
export async function guestLimitReached(): Promise<string | null> {
  const store = jobStore();
  const since = (ms: number) => new Date(Date.now() - ms).toISOString();
  if ((await store.countJobs(since(GUEST_LIMITS.days * DAY_MS))) >= GUEST_LIMITS.perGuest) {
    return `Guests get ${GUEST_LIMITS.perGuest} learns, runs, repairs or AI edits, and you've used them. Sign up (it's free) to keep going.`;
  }
  if ((await store.countJobs(since(DAY_MS), GUEST_PREFIX)) >= GUEST_LIMITS.perDay) {
    return "Guest mode has reached its limit for today. Sign up (it's free) to keep going, or try again tomorrow.";
  }
  return null;
}

/** Counts a paid action that doesn't start a job (an AI edit) toward the guest's limit. */
export async function recordGuestCall(type: string): Promise<void> {
  await jobStore().createJob({ id: newId(), type, status: "done", created_at: new Date().toISOString() });
}
