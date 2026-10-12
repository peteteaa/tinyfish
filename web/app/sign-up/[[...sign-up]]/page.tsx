import { SignUp } from "@clerk/nextjs";
import { redirect } from "next/navigation";
import { AUTH_ENABLED } from "@/lib/authConfig";

export default function SignUpPage() {
  if (!AUTH_ENABLED) redirect("/");
  return (
    <main className="column auth-page">
      <h1>workflow-memory</h1>
      <p>Create an account. Your workflows and runs are private to you.</p>
      <SignUp />
    </main>
  );
}
