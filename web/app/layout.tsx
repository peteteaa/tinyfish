import { ClerkProvider, Show, UserButton } from "@clerk/nextjs";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Instrument_Sans, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { AUTH_ENABLED, GUEST_COOKIE, GUEST_ENABLED, GUEST_LIMITS, SIGN_IN_URL, SIGN_UP_URL, isGuestId } from "@/lib/authConfig";
import "./globals.css";

const sans = Instrument_Sans({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-sans", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "600"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = { title: "workflow-memory" };

// Clerk's sign-in and account screens use the app's colors, so they follow the light/dark theme.
const clerkAppearance = {
  variables: {
    colorPrimary: "var(--signal)",
    colorBackground: "var(--surface)",
    colorForeground: "var(--ink)",
    colorMutedForeground: "var(--muted)",
    colorInput: "var(--surface)",
    colorInputForeground: "var(--ink)",
    colorDanger: "var(--fail)",
    colorSuccess: "var(--pass)",
    colorBorder: "var(--border)",
    fontFamily: "var(--font-sans), system-ui, sans-serif",
  },
};

/** Shown to signed-out visitors browsing as a guest. */
async function GuestBar() {
  if (!isGuestId((await cookies()).get(GUEST_COOKIE)?.value)) return null;
  return (
    <div className="account-bar guest-bar">
      <span className="muted small">
        Guest mode: up to {GUEST_LIMITS.perGuest} learns, runs or AI edits. What you make stays in this browser and doesn&apos;t move to
        an account.
      </span>
      <Link href={SIGN_UP_URL}>Sign up</Link>
    </div>
  );
}

// Applies the saved theme before paint to avoid a flash.
const themeInit = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        {AUTH_ENABLED ? (
          <ClerkProvider signInUrl={SIGN_IN_URL} signUpUrl={SIGN_UP_URL} appearance={clerkAppearance}>
            <Show when="signed-in">
              <div className="account-bar">
                <UserButton showName />
              </div>
            </Show>
            {GUEST_ENABLED && (
              <Show when="signed-out">
                <GuestBar />
              </Show>
            )}
            {children}
          </ClerkProvider>
        ) : (
          children
        )}
      </body>
    </html>
  );
}
