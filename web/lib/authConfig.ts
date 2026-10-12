// Kept apart from lib/auth.ts so proxy.ts and the root layout can read it without pulling in core (the store).

/**
 * Sign-in (Clerk) is on when its keys are set; the Clerk Vercel Marketplace integration adds them. Without them the
 * app is single-user: everyone acts as "local", the CLI's owner.
 */
export const AUTH_ENABLED = !!(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);

export const SIGN_IN_URL = "/sign-in";
export const SIGN_UP_URL = "/sign-up";
