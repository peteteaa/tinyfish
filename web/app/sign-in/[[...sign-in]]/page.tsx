import { SignIn } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { AUTH_ENABLED, GUEST_ENABLED, GUEST_URL } from "@/lib/authConfig";

export default function SignInPage() {
  if (!AUTH_ENABLED) redirect("/");
  return (
    <main className="column auth-page">
      <h1>workflow-memory</h1>
      <p>Sign in to see and run your saved workflows.</p>
      <SignIn />
      {GUEST_ENABLED && (
        // A plain <a>: /guest sets a cookie, and <Link> would prefetch it.
        <p className="muted">
          Just looking? <a href={GUEST_URL}>Try it without an account</a>.
        </p>
      )}
    </main>
  );
}
