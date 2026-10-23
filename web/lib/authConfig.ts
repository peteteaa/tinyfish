// Kept apart from lib/auth.ts so proxy.ts and the root layout can read it without pulling in core (the store).

/**
 * Sign-in (Clerk) is on when its keys are set; the Clerk Vercel Marketplace integration adds them. Without them the
 * app is single-user: everyone acts as "local", the CLI's owner.
 */
export const AUTH_ENABLED = !!(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);

export const SIGN_IN_URL = "/sign-in";
export const SIGN_UP_URL = "/sign-up";

/**
 * Guest mode: visitors can try the app without an account (see lib/guest.ts). Needs sign-in on, since without it
 * everyone already gets in; GUEST_MODE=off turns it off.
 */
export const GUEST_ENABLED = AUTH_ENABLED && process.env.GUEST_MODE !== "off";
export const GUEST_URL = "/guest";
export const GUEST_COOKIE = "wm_guest";

const GUEST_ID = /^guest_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Strict, so a forged cookie can only name another guest, never a Clerk user ("user_...") or "local". */
export const isGuestId = (v: string | undefined | null): v is string => !!v && GUEST_ID.test(v);

const envCount = (v: string | undefined, fallback: number) => (v && /^\d+$/.test(v) ? Number(v) : fallback);
/**
 * Guests spend real TinyFish and Gemini credits, so paid actions (learn, run, repair, AI edit) are capped: per guest
 * over the guest cookie's lifetime, and across all guests per day, which also keeps guests from using up the Gemini
 * quota signed-in users share.
 */
export const GUEST_LIMITS = {
  perGuest: envCount(process.env.GUEST_ACTION_LIMIT, 5),
  perDay: envCount(process.env.GUEST_DAILY_LIMIT, 50),
  days: 30,
};
