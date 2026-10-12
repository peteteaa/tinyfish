import { SignIn } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/authConfig";

export default function SignInPage() {
  if (!AUTH_ENABLED) redirect("/");
  return (
    <main className="column auth-page">
      <h1>workflow-memory</h1>
      <p>Sign in to see and run your saved workflows.</p>
      <SignIn />
    </main>
  );
}
