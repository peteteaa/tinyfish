import Link from "next/link";
import { listWorkflows } from "@core/store.js";
import { Composer } from "@/components/Composer";
import { DeleteWorkflowButton } from "@/components/DeleteWorkflowButton";
import { SOURCE_LABEL } from "@/lib/learnEvents";
import { ThemeToggle } from "./theme-toggle";
import { asUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: { searchParams: Promise<{ goal?: string | string[] }> }) {
  return asUser(async () => {
    const { goal } = await searchParams;
    const initialGoal = Array.isArray(goal) ? goal[0] : goal;
    const workflows = await listWorkflows();
    return (
      <main className="column">
        <header className="page-header">
          <h1>workflow-memory</h1>
          <ThemeToggle />
        </header>
        <p>Describe a web task once. Rerun it as a tested workflow.</p>
        <Composer initialGoal={initialGoal ?? ""} />
        <section className="panel" aria-labelledby="saved">
          <h2 id="saved">Saved workflows</h2>
          {workflows.length === 0 ? (
            <p className="muted">Nothing saved yet. Describe a web task above and we&apos;ll learn it, or import a workflow file.</p>
          ) : (
            <ul className="list">
              {workflows.map((w) => (
                <li key={w.name}>
                  <Link href={`/workflows/${w.name}`}><strong>{w.name}</strong></Link>
                  <span className="muted">{w.description}</span>
                  <span className="muted small">v{w.latest} · {SOURCE_LABEL[w.latest_source] ?? w.latest_source}</span>
                  <DeleteWorkflowButton name={w.name} compact />
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    );
  });
}
